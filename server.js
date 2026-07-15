import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import {
  applyMove, BOARD_SIZE, generateBoard, ROUND_MS, validateMoveCadence, validateReplay,
} from './src/game-engine.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.cwd();
const DATA_DIR = process.env.FRUITBOX_DATA_DIR || join(ROOT, 'data');
const DIST_DIR = join(ROOT, 'dist');
mkdirSync(DATA_DIR, { recursive: true });
const secretPath = join(DATA_DIR, 'leaderboard-secret');
const secret = process.env.LEADERBOARD_SECRET
  || (existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : randomUUID());
if (!existsSync(secretPath) && !process.env.LEADERBOARD_SECRET) writeFileSync(secretPath, secret, { mode: 0o600 });

const db = new DatabaseSync(join(DATA_DIR, 'fruitbox.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    seed INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    score INTEGER,
    duration_ms INTEGER,
    moves_json TEXT,
    verified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS runs_leaderboard ON runs(verified, score DESC, duration_ms ASC, finished_at ASC);
`);
const runColumns = new Set(db.prepare('PRAGMA table_info(runs)').all().map(({ name }) => name));
if (!runColumns.has('anti_cheat')) db.exec('ALTER TABLE runs ADD COLUMN anti_cheat INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS run_moves (
    run_id TEXT NOT NULL REFERENCES runs(id),
    move_id INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    cells_json TEXT NOT NULL,
    PRIMARY KEY (run_id, move_id)
  );
`);

const getPlayer = db.prepare('SELECT id, display_name AS displayName FROM players WHERE id = ?');
const insertPlayer = db.prepare('INSERT INTO players (id, display_name, created_at) VALUES (?, ?, ?)');
const updatePlayerName = db.prepare('UPDATE players SET display_name = ? WHERE id = ?');
const insertRun = db.prepare('INSERT INTO runs (id, player_id, seed, started_at, anti_cheat) VALUES (?, ?, ?, ?, 1)');
const getRun = db.prepare('SELECT * FROM runs WHERE id = ?');
const finishRun = db.prepare('UPDATE runs SET finished_at = ?, score = ?, duration_ms = ?, moves_json = ?, verified = 1 WHERE id = ?');
const disqualifyRun = db.prepare('UPDATE runs SET finished_at = ?, verified = -1 WHERE id = ? AND verified = 0');
const getRunMoves = db.prepare('SELECT move_id AS moveId, received_at AS receivedAt, cells_json AS cellsJson FROM run_moves WHERE run_id = ? ORDER BY move_id');
const insertRunMove = db.prepare('INSERT INTO run_moves (run_id, move_id, received_at, cells_json) VALUES (?, ?, ?, ?)');
const deleteRunMoves = db.prepare('DELETE FROM run_moves WHERE run_id = ?');
const insertVerifiedRun = db.prepare(`
  INSERT INTO runs (id, player_id, seed, started_at, finished_at, score, duration_ms, moves_json, verified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
`);
const hiddenLeaderboardNames = ['¯\\_(ツ)_/¯', 'Bot'];
const leaderboard = db.prepare(`
  SELECT players.display_name AS displayName, runs.score, runs.duration_ms AS durationMs, runs.finished_at AS finishedAt
  FROM runs JOIN players ON players.id = runs.player_id
  WHERE runs.verified = 1 AND players.display_name NOT IN (?, ?)
  ORDER BY runs.score DESC, runs.duration_ms ASC, runs.finished_at ASC
  LIMIT ?
`);

function leaderboardEntries(limit) {
  return leaderboard.all(...hiddenLeaderboardNames, limit);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 500_000) throw new Error('Request too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

function sign(runId) {
  return createHmac('sha256', secret).update(runId).digest('base64url');
}

function validToken(runId, token) {
  if (typeof token !== 'string') return false;
  const expected = Buffer.from(sign(runId));
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function cleanDisplayName(value) {
  if (typeof value !== 'string') throw new Error('Enter a name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 20 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new Error('Names must be 2–20 characters.');
  }
  return name;
}

function createPlayer(displayName) {
  const playerId = randomUUID();
  const player = { id: playerId, displayName: displayName || `player-${playerId.slice(0, 4)}` };
  insertPlayer.run(player.id, player.displayName, Date.now());
  return player;
}

function playerFor(id) {
  if (typeof id === 'string') {
    const existing = getPlayer.get(id);
    if (existing) return existing;
  }
  return createPlayer();
}

const rooms = new Map();
const roomConnections = new Map();
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createRoomCode() {
  let code;
  do code = Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
  while (rooms.has(code));
  return code;
}

function roomSnapshot(room, viewerId) {
  const connections = roomConnections.get(room.code) || new Set();
  const players = [...room.players.values()]
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified) || b.score - a.score || (a.completionMs || Infinity) - (b.completionMs || Infinity) || a.seat - b.seat)
    .map(({ id, displayName, ready, score, wins, completionMs, seat, disqualified }) => ({
      id, displayName, ready, score, wins, completionMs, seat, disqualified,
      connected: [...connections].some((socket) => socket.playerId === id && socket.readyState === 1),
    }));
  return {
    code: room.code, status: room.status, hostPlayerId: room.hostPlayerId,
    maxPlayers: room.maxPlayers, seed: room.seed, startsAt: room.startsAt,
    finishedAt: room.finishedAt, serverNow: Date.now(), players,
    board: room.players.get(viewerId)?.board || null,
  };
}

function sendRoom(socket, room) {
  if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'room', room: roomSnapshot(room, socket.playerId) }));
}

function broadcastRoom(room) {
  for (const socket of roomConnections.get(room.code) || []) sendRoom(socket, room);
}

function finishMultiplayerRoom(room) {
  if (room.status === 'finished') return;
  clearTimeout(room.finishTimer);
  room.status = 'finished';
  room.finishedAt = Date.now();
  const eligiblePlayers = [...room.players.values()].filter((player) => !player.disqualified);
  const highestScore = eligiblePlayers.length ? Math.max(...eligiblePlayers.map((player) => player.score)) : 0;
  let winners = eligiblePlayers.filter((player) => player.score === highestScore);
  if (winners.length > 1 && highestScore === BOARD_SIZE) {
    const fastest = Math.min(...winners.map((player) => player.completionMs || ROUND_MS));
    winners = winners.filter((player) => (player.completionMs || ROUND_MS) === fastest);
  }
  if (room.players.size > 1 && winners.length === 1) winners[0].wins += 1;
  for (const player of room.players.values()) {
    if (player.disqualified) continue;
    insertVerifiedRun.run(
      randomUUID(), player.id, room.seed, room.startsAt, room.finishedAt,
      player.score, player.completionMs || ROUND_MS, JSON.stringify(player.moves),
    );
  }
  broadcastRoom(room);
}

function beginRoomCountdown(room) {
  if (room.status !== 'armed' || room.players.size < 1 || ![...room.players.values()].every((player) => player.ready)) return;
  room.status = 'countdown';
  room.seed = randomInt(1, 2_147_483_647);
  room.startsAt = Date.now() + 5_000;
  broadcastRoom(room);
  room.startTimer = setTimeout(() => {
    if (room.status !== 'countdown') return;
    room.status = 'live';
    for (const player of room.players.values()) {
      Object.assign(player, {
        board: generateBoard(room.seed), score: 0, moves: [], lastMoveId: 0, completionMs: null, disqualified: false,
      });
    }
    broadcastRoom(room);
    room.finishTimer = setTimeout(() => finishMultiplayerRoom(room), ROUND_MS);
  }, Math.max(0, room.startsAt - Date.now()));
}

function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new Error('Room not found.');
  return room;
}

function addPlayerToRoom(room, player) {
  if (room.players.has(player.id)) return;
  if (room.status !== 'open') throw new Error('This room is no longer accepting players.');
  if (room.players.size >= room.maxPlayers) throw new Error('This room is full.');
  room.players.set(player.id, {
    ...player, seat: room.players.size, ready: false, score: 0, wins: 0,
    board: null, moves: [], lastMoveId: 0, completionMs: null, disqualified: false,
  });
}

async function serveFile(requestPath, response) {
  const relativePath = requestPath === '/' ? 'index.html' : normalize(requestPath).replace(/^([.][.][/\\])+/, '');
  const path = join(DIST_DIR, relativePath);
  try {
    const file = await stat(path);
    if (!file.isFile()) throw new Error('Not a file');
    const extension = path.split('.').pop();
    const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' };
    response.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream' });
    createReadStream(path).pipe(response);
  } catch {
    if (requestPath !== '/' && existsSync(join(DIST_DIR, 'index.html'))) return serveFile('/', response);
    json(response, 404, { error: 'Build the site first with npm run build.' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'POST' && url.pathname === '/api/players') {
      const { displayName } = await readJson(request);
      return json(response, 201, createPlayer(cleanDisplayName(displayName)));
    }
    if (request.method === 'GET' && /^\/api\/players\/[^/]+$/.test(url.pathname)) {
      const player = getPlayer.get(decodeURIComponent(url.pathname.split('/')[3]));
      return player ? json(response, 200, player) : json(response, 404, { error: 'Player not found.' });
    }
    if (request.method === 'PATCH' && /^\/api\/players\/[^/]+$/.test(url.pathname)) {
      const playerId = decodeURIComponent(url.pathname.split('/')[3]);
      if (!getPlayer.get(playerId)) return json(response, 404, { error: 'Player not found.' });
      const { displayName } = await readJson(request);
      const player = { id: playerId, displayName: cleanDisplayName(displayName) };
      updatePlayerName.run(player.displayName, player.id);
      return json(response, 200, player);
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const { playerId } = await readJson(request);
      const player = playerFor(playerId);
      const code = createRoomCode();
      const room = {
        code, hostPlayerId: player.id, maxPlayers: 8, status: 'open', seed: null,
        createdAt: Date.now(), startsAt: null, finishedAt: null, players: new Map(), startTimer: null, finishTimer: null,
      };
      addPlayerToRoom(room, player);
      rooms.set(code, room);
      return json(response, 201, { room: roomSnapshot(room, player.id), player });
    }
    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      const openRooms = [...rooms.values()]
        .filter((room) => {
          const hostIsConnected = [...(roomConnections.get(room.code) || [])]
            .some((socket) => socket.playerId === room.hostPlayerId && socket.readyState === 1);
          return room.status === 'open' && room.players.size < room.maxPlayers && hostIsConnected;
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((room) => ({
          code: room.code,
          hostName: room.players.get(room.hostPlayerId)?.displayName || 'unknown',
          playerCount: room.players.size,
          maxPlayers: room.maxPlayers,
          createdAt: room.createdAt,
        }));
      return json(response, 200, { rooms: openRooms });
    }
    if (request.method === 'POST' && /^\/api\/rooms\/[^/]+\/join$/.test(url.pathname)) {
      const { playerId } = await readJson(request);
      const room = getRoom(url.pathname.split('/')[3]);
      const player = playerFor(playerId);
      addPlayerToRoom(room, player);
      broadcastRoom(room);
      return json(response, 200, { room: roomSnapshot(room, player.id), player });
    }
    if (request.method === 'POST' && /^\/api\/rooms\/[^/]+\/ready$/.test(url.pathname)) {
      const room = getRoom(url.pathname.split('/')[3]);
      const { playerId, ready } = await readJson(request);
      const player = room.players.get(playerId);
      if (!player || !['open', 'armed'].includes(room.status)) throw new Error('Ready state cannot be changed now.');
      player.ready = Boolean(ready);
      broadcastRoom(room);
      beginRoomCountdown(room);
      return json(response, 200, { room: roomSnapshot(room, playerId) });
    }
    if (request.method === 'POST' && /^\/api\/rooms\/[^/]+\/arm$/.test(url.pathname)) {
      const room = getRoom(url.pathname.split('/')[3]);
      const { playerId } = await readJson(request);
      if (room.hostPlayerId !== playerId || room.status !== 'open') throw new Error('Only the host can arm this room.');
      room.status = 'armed';
      broadcastRoom(room);
      beginRoomCountdown(room);
      return json(response, 200, { room: roomSnapshot(room, playerId) });
    }
    if (request.method === 'POST' && /^\/api\/rooms\/[^/]+\/rematch$/.test(url.pathname)) {
      const room = getRoom(url.pathname.split('/')[3]);
      const { playerId } = await readJson(request);
      if (room.hostPlayerId !== playerId || room.status !== 'finished') throw new Error('Only the host can start a rematch.');
      room.status = 'open';
      room.seed = null;
      room.startsAt = null;
      room.finishedAt = null;
      for (const player of room.players.values()) {
        Object.assign(player, { ready: false, score: 0, board: null, moves: [], lastMoveId: 0, completionMs: null, disqualified: false });
      }
      broadcastRoom(room);
      return json(response, 200, { room: roomSnapshot(room, playerId) });
    }
    if (request.method === 'POST' && url.pathname === '/api/runs') {
      const { playerId } = await readJson(request);
      const player = playerFor(playerId);
      const run = { id: randomUUID(), seed: randomInt(1, 2_147_483_647), startedAt: Date.now() };
      insertRun.run(run.id, player.id, run.seed, run.startedAt);
      return json(response, 201, { ...run, token: sign(run.id), antiCheat: true, player });
    }
    if (request.method === 'POST' && /^\/api\/runs\/[^/]+\/moves$/.test(url.pathname)) {
      const runId = url.pathname.split('/')[3];
      const { token, moveId, cells } = await readJson(request);
      const run = getRun.get(runId);
      if (!run || run.verified || run.anti_cheat !== 1 || !validToken(runId, token)) {
        return json(response, 401, { error: 'This run is not valid.' });
      }
      const priorMoves = getRunMoves.all(runId);
      if (!Number.isInteger(moveId) || moveId !== priorMoves.length + 1) {
        throw new Error('Moves arrived out of order.');
      }
      const receivedAt = Date.now();
      const movedAt = receivedAt - run.started_at;
      if (movedAt < 0 || movedAt > ROUND_MS + 1_000) throw new Error('Move outside the round.');
      const moveTimes = [...priorMoves.map((move) => move.receivedAt - run.started_at), movedAt];
      try {
        validateMoveCadence(moveTimes);
        const board = generateBoard(run.seed);
        priorMoves.forEach((move) => applyMove(board, JSON.parse(move.cellsJson)));
        applyMove(board, cells);
      } catch (error) {
        disqualifyRun.run(receivedAt, runId);
        throw error;
      }
      insertRunMove.run(runId, moveId, receivedAt, JSON.stringify(cells));
      return json(response, 201, { moveId, at: Math.min(movedAt, ROUND_MS) });
    }
    if (request.method === 'POST' && /^\/api\/runs\/[^/]+\/finish$/.test(url.pathname)) {
      const runId = url.pathname.split('/')[3];
      const { token, moves: submittedMoves, moveCount } = await readJson(request);
      const run = getRun.get(runId);
      if (!run || run.verified || !validToken(runId, token)) return json(response, 401, { error: 'This run is not valid.' });
      let moves = submittedMoves;
      if (run.anti_cheat === 1) {
        const liveMoves = getRunMoves.all(runId);
        if (!Number.isInteger(moveCount) || moveCount !== liveMoves.length) {
          throw new Error('The live move record is incomplete.');
        }
        moves = liveMoves.map((move) => ({
          at: Math.min(move.receivedAt - run.started_at, ROUND_MS),
          cells: JSON.parse(move.cellsJson),
        }));
        validateMoveCadence(moves.map(({ at }) => at));
      }
      const replay = validateReplay(run.seed, moves);
      const elapsed = Date.now() - run.started_at;
      if (!replay.cleared && elapsed < ROUND_MS - 1_500) return json(response, 422, { error: 'A non-cleared run must last two minutes.' });
      if (elapsed > ROUND_MS + 30_000) return json(response, 422, { error: 'This run expired before it was submitted.' });
      const durationMs = replay.cleared ? Math.min(elapsed, ROUND_MS) : ROUND_MS;
      const finishedAt = Date.now();
      finishRun.run(finishedAt, replay.score, durationMs, JSON.stringify(moves), runId);
      deleteRunMoves.run(runId);
      const rank = leaderboardEntries(1000).findIndex((entry) => entry.finishedAt === finishedAt) + 1;
      return json(response, 201, { score: replay.score, durationMs, rank });
    }
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      const requestedLimit = Number(url.searchParams.get('limit') || 20);
      return json(response, 200, { entries: leaderboardEntries(Math.max(1, Math.min(requestedLimit, 100))) });
    }
    return serveFile(url.pathname, response);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 422;
    return json(response, status, { error: error.message || 'Unable to process this request.' });
  }
});

const webSockets = new WebSocketServer({ server, path: '/ws' });
webSockets.on('connection', (socket, request) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const room = getRoom(url.searchParams.get('room'));
    const playerId = url.searchParams.get('player');
    if (!room.players.has(playerId)) throw new Error('You are not in this room.');
    socket.playerId = playerId;
    socket.roomCode = room.code;
    if (!roomConnections.has(room.code)) roomConnections.set(room.code, new Set());
    roomConnections.get(room.code).add(socket);
    broadcastRoom(room);

    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'move' || room.status !== 'live') return;
        const player = room.players.get(playerId);
        if (player.disqualified) throw new Error('This round was disqualified.');
        if (!Number.isInteger(message.moveId) || message.moveId !== player.lastMoveId + 1) throw new Error('Moves arrived out of order.');
        const movedAt = Date.now() - room.startsAt;
        if (movedAt < 0 || movedAt > ROUND_MS) throw new Error('Move outside the round.');
        try {
          validateMoveCadence([...player.moves.map(({ at }) => at), movedAt]);
        } catch (error) {
          player.disqualified = true;
          broadcastRoom(room);
          throw error;
        }
        const result = applyMove(player.board, message.cells);
        player.lastMoveId = message.moveId;
        player.score += result.cleared;
        player.moves.push({ at: Math.min(movedAt, ROUND_MS), cells: message.cells });
        if (player.score === BOARD_SIZE && !player.completionMs) player.completionMs = movedAt;
        broadcastRoom(room);
        if ([...room.players.values()].every((entry) => entry.score === BOARD_SIZE)) finishMultiplayerRoom(room);
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', message: error.message }));
        sendRoom(socket, room);
      }
    });
    socket.on('close', () => {
      roomConnections.get(room.code)?.delete(socket);
      broadcastRoom(room);
    });
  } catch (error) {
    socket.close(1008, error.message);
  }
});

server.listen(PORT, HOST, () => console.log(`Fruitbox is running on http://${HOST}:${PORT}`));
