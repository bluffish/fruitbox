import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BOARD_SIZE, ROUND_MS, validateReplay } from './src/game-engine.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
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

const getPlayer = db.prepare('SELECT id, display_name AS displayName FROM players WHERE id = ?');
const insertPlayer = db.prepare('INSERT INTO players (id, display_name, created_at) VALUES (?, ?, ?)');
const updatePlayerName = db.prepare('UPDATE players SET display_name = ? WHERE id = ?');
const insertRun = db.prepare('INSERT INTO runs (id, player_id, seed, started_at) VALUES (?, ?, ?, ?)');
const getRun = db.prepare('SELECT * FROM runs WHERE id = ?');
const finishRun = db.prepare('UPDATE runs SET finished_at = ?, score = ?, duration_ms = ?, moves_json = ?, verified = 1 WHERE id = ?');
const leaderboard = db.prepare(`
  SELECT players.display_name AS displayName, runs.score, runs.duration_ms AS durationMs, runs.finished_at AS finishedAt
  FROM runs JOIN players ON players.id = runs.player_id
  WHERE runs.verified = 1
  ORDER BY runs.score DESC, runs.duration_ms ASC, runs.finished_at ASC
  LIMIT ?
`);

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
    if (request.method === 'POST' && url.pathname === '/api/runs') {
      const { playerId } = await readJson(request);
      const player = playerFor(playerId);
      const run = { id: randomUUID(), seed: randomInt(1, 2_147_483_647), startedAt: Date.now() };
      insertRun.run(run.id, player.id, run.seed, run.startedAt);
      return json(response, 201, { ...run, token: sign(run.id), player });
    }
    if (request.method === 'POST' && /^\/api\/runs\/[^/]+\/finish$/.test(url.pathname)) {
      const runId = url.pathname.split('/')[3];
      const { token, moves } = await readJson(request);
      const run = getRun.get(runId);
      if (!run || run.verified || !validToken(runId, token)) return json(response, 401, { error: 'This run is not valid.' });
      const replay = validateReplay(run.seed, moves);
      const elapsed = Date.now() - run.started_at;
      if (!replay.cleared && elapsed < ROUND_MS - 1_500) return json(response, 422, { error: 'A non-cleared run must last two minutes.' });
      if (elapsed > ROUND_MS + 30_000) return json(response, 422, { error: 'This run expired before it was submitted.' });
      const durationMs = replay.cleared ? Math.min(elapsed, ROUND_MS) : ROUND_MS;
      const finishedAt = Date.now();
      finishRun.run(finishedAt, replay.score, durationMs, JSON.stringify(moves), runId);
      const rank = leaderboard.all(1000).findIndex((entry) => entry.finishedAt === finishedAt) + 1;
      return json(response, 201, { score: replay.score, durationMs, rank });
    }
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      const requestedLimit = Number(url.searchParams.get('limit') || 20);
      return json(response, 200, { entries: leaderboard.all(Math.max(1, Math.min(requestedLimit, 100))) });
    }
    return serveFile(url.pathname, response);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 422;
    return json(response, status, { error: error.message || 'Unable to process this request.' });
  }
});

server.listen(PORT, HOST, () => console.log(`Fruitbox is running on http://${HOST}:${PORT}`));
