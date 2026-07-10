import './style.css';
import { BOARD_SIZE, COLS, generateBoard, ROWS, ROUND_MS } from './game-engine.js';

const ROUND_SECONDS = ROUND_MS / 1000;
const boardEl = document.querySelector('#board');
const boardFrameEl = document.querySelector('.board-frame');
const scoreEl = document.querySelector('#score');
const timerEl = document.querySelector('#timer');
const gameOverEl = document.querySelector('#game-over');
const finalScoreEl = document.querySelector('#final-score');
const selectionBoxEl = document.querySelector('#selection-box');
const leaderboardEl = document.querySelector('#leaderboard-list');
const usernameDialog = document.querySelector('#username-dialog');
const usernameForm = document.querySelector('#username-form');
const usernameInput = document.querySelector('#username-input');
const usernameError = document.querySelector('#username-error');
const highlightMissedButton = document.querySelector('#highlight-missed');
const reviewToolbar = document.querySelector('#review-toolbar');
const reviewLabel = document.querySelector('#review-label');
const showMissedButton = document.querySelector('#show-missed');
const nextMissedButton = document.querySelector('#next-missed');
const hideMissedButton = document.querySelector('#hide-missed');
const reviewRematchButton = document.querySelector('#review-rematch');
const appShell = document.querySelector('.app-shell');
const playArea = document.querySelector('#play-area');
const globalLeaderboard = document.querySelector('#global-leaderboard');
const roomScreen = document.querySelector('#room-screen');
const roomEntry = document.querySelector('#room-entry');
const roomLobby = document.querySelector('#room-lobby');
const roomCodeEl = document.querySelector('#room-code');
const roomStateEl = document.querySelector('#room-state');
const roomRoster = document.querySelector('#room-roster');
const roomError = document.querySelector('#room-error');
const roomEntryError = document.querySelector('#room-entry-error');
const readyRoomButton = document.querySelector('#ready-room');
const armRoomButton = document.querySelector('#arm-room');
const roomStandings = document.querySelector('#room-standings');
const standingsCode = document.querySelector('#standings-code');
const standingsList = document.querySelector('#standings-list');
const openRoomsList = document.querySelector('#open-rooms');

let board = [];
let cells = [];
let score = 0;
let secondsLeft = ROUND_SECONDS;
let selectionStart = null;
let currentSelection = null;
let timerId = null;
let playing = false;
let activeRun = null;
let moves = [];
let startedAt = 0;
let submitting = false;
let startRequestId = 0;
let currentPlayer = null;
let missedMoves = [];
let hintIndex = -1;
let gameMode = 'solo';
let activeRoom = null;
let roomSocket = null;
let roomGameStarted = false;
let roomCountdownTimer = null;
let roomMoveId = 0;
let roomListTimer = null;

function formatTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function selectionBounds(a, b) {
  return {
    top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
    left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
  };
}

function selectedCells(bounds) {
  const selected = [];
  cells.forEach((row, rowIndex) => row.forEach((cell, colIndex) => {
    const centerX = cell.offsetLeft + cell.offsetWidth / 2;
    const centerY = cell.offsetTop + cell.offsetHeight / 2;
    const forgiveness = Math.min(cell.offsetWidth, cell.offsetHeight) * 0.28;
    if (
      board[rowIndex][colIndex] !== null
      && centerX >= bounds.left - forgiveness && centerX <= bounds.right + forgiveness
      && centerY >= bounds.top - forgiveness && centerY <= bounds.bottom + forgiveness
    ) selected.push({ row: rowIndex, col: colIndex });
  }));
  return selected;
}

function selectionInfo(bounds) {
  let total = 0;
  const selected = selectedCells(bounds);
  selected.forEach(({ row, col }) => { total += board[row][col]; });
  return { total, selected };
}

function updateSelection(end) {
  if (!selectionStart) return;
  currentSelection = selectionBounds(selectionStart, end);
  const { total } = selectionInfo(currentSelection);
  selectionBoxEl.hidden = false;
  selectionBoxEl.classList.toggle('valid', total === 10);
  selectionBoxEl.style.left = `${currentSelection.left}px`;
  selectionBoxEl.style.top = `${currentSelection.top}px`;
  selectionBoxEl.style.width = `${currentSelection.right - currentSelection.left}px`;
  selectionBoxEl.style.height = `${currentSelection.bottom - currentSelection.top}px`;
}

function clearSelection() {
  selectionStart = null;
  currentSelection = null;
  selectionBoxEl.hidden = true;
  selectionBoxEl.classList.remove('valid', 'missed');
  delete selectionBoxEl.dataset.label;
}

function rectangleTotal(prefix, top, left, bottom, right) {
  return prefix[bottom + 1][right + 1] - prefix[top][right + 1] - prefix[bottom + 1][left] + prefix[top][left];
}

function makePrefix(mapper) {
  const prefix = Array.from({ length: ROWS + 1 }, () => Array(COLS + 1).fill(0));
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      prefix[row + 1][col + 1] = mapper(row, col) + prefix[row][col + 1] + prefix[row + 1][col] - prefix[row][col];
    }
  }
  return prefix;
}

function findMissedMoves() {
  const totals = makePrefix((row, col) => board[row][col] || 0);
  const apples = makePrefix((row, col) => (board[row][col] === null ? 0 : 1));
  const moves = [];
  for (let top = 0; top < ROWS; top += 1) {
    for (let bottom = top; bottom < ROWS; bottom += 1) {
      for (let left = 0; left < COLS; left += 1) {
        for (let right = left; right < COLS; right += 1) {
          const count = rectangleTotal(apples, top, left, bottom, right);
          if (count === 0 || rectangleTotal(totals, top, left, bottom, right) !== 10) continue;
          // Keep only the canonical box around its apples. This avoids showing
          // the same move repeatedly with a border of already-cleared cells.
          const hasAppleOnEachEdge = rectangleTotal(apples, top, left, top, right) > 0
            && rectangleTotal(apples, bottom, left, bottom, right) > 0
            && rectangleTotal(apples, top, left, bottom, left) > 0
            && rectangleTotal(apples, top, right, bottom, right) > 0;
          if (hasAppleOnEachEdge) moves.push({ top, bottom, left, right, count, area: (bottom - top + 1) * (right - left + 1) });
        }
      }
    }
  }
  return moves.sort((a, b) => b.count - a.count || a.area - b.area || a.top - b.top || a.left - b.left);
}

function renderReviewToolbar() {
  const roomFinished = gameMode === 'room' && activeRoom?.status === 'finished';
  reviewRematchButton.hidden = !roomFinished;
  if (roomFinished) {
    reviewRematchButton.textContent = activeRoom.hostPlayerId === currentPlayer.id ? 'rematch' : 'waiting for host';
    reviewRematchButton.disabled = activeRoom.hostPlayerId !== currentPlayer.id;
  }
  if (!missedMoves.length) {
    reviewToolbar.hidden = !roomFinished;
    highlightMissedButton.hidden = true;
    if (roomFinished) reviewLabel.textContent = 'round finished';
    return;
  }
  reviewToolbar.hidden = false;
  const showingHint = hintIndex >= 0;
  const move = missedMoves[hintIndex];
  reviewLabel.textContent = showingHint
    ? `missed move ${hintIndex + 1}/${missedMoves.length} · ${move.count} apples`
    : `${missedMoves.length} missed move${missedMoves.length === 1 ? '' : 's'}`;
  showMissedButton.hidden = showingHint;
  nextMissedButton.hidden = !showingHint || missedMoves.length < 2;
  hideMissedButton.hidden = !showingHint;
}

function hideMissedMove() {
  hintIndex = -1;
  selectionBoxEl.hidden = true;
  selectionBoxEl.classList.remove('missed');
  delete selectionBoxEl.dataset.label;
  renderReviewToolbar();
}

function showMissedMove(index = 0) {
  if (!missedMoves.length) return;
  hintIndex = ((index % missedMoves.length) + missedMoves.length) % missedMoves.length;
  const move = missedMoves[hintIndex];
  const first = cells[move.top][move.left];
  const last = cells[move.bottom][move.right];
  selectionBoxEl.hidden = false;
  selectionBoxEl.classList.remove('valid');
  selectionBoxEl.classList.add('missed');
  selectionBoxEl.dataset.label = '10';
  selectionBoxEl.style.left = `${first.offsetLeft - 3}px`;
  selectionBoxEl.style.top = `${first.offsetTop - 3}px`;
  selectionBoxEl.style.width = `${last.offsetLeft + last.offsetWidth - first.offsetLeft + 6}px`;
  selectionBoxEl.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop + 6}px`;
  renderReviewToolbar();
}

function endGame() {
  if (!playing) return;
  playing = false;
  clearInterval(timerId);
  clearSelection();
  missedMoves = findMissedMoves();
  hintIndex = -1;
  highlightMissedButton.hidden = missedMoves.length === 0;
  reviewToolbar.hidden = true;
  finalScoreEl.textContent = score;
  gameOverEl.hidden = false;
  submitRun();
}

function tick() {
  const remainingMs = gameMode === 'room' && activeRoom
    ? activeRoom.startsAt + ROUND_MS - Date.now()
    : ROUND_MS - (performance.now() - startedAt);
  secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));
  timerEl.textContent = formatTime(secondsLeft);
  if (secondsLeft <= 0 && gameMode === 'solo') endGame();
}

function renderBoard() {
  boardEl.replaceChildren(selectionBoxEl);
  cells = Array.from({ length: ROWS }, () => Array(COLS));
  board.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `fruit fruit-${(value % 4) + 1}`;
    cell.textContent = value;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `Fruit ${value}, row ${rowIndex + 1}, column ${colIndex + 1}`);
    cell.dataset.row = rowIndex;
    cell.dataset.col = colIndex;
    if (value === null) { cell.disabled = true; cell.classList.add('cleared'); }
    boardEl.append(cell);
    cells[rowIndex][colIndex] = cell;
  }));
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}

function setRoomUrl(code = '') {
  history.pushState({}, '', code ? `/room/${code}` : '/room');
}

function showRoomEntry() {
  gameMode = 'room';
  playing = false;
  clearInterval(timerId);
  roomScreen.hidden = false;
  roomEntry.hidden = false;
  roomLobby.hidden = true;
  playArea.hidden = true;
  globalLeaderboard.hidden = true;
  document.querySelector('.status').hidden = true;
  appShell.classList.remove('room-playing');
  setRoomUrl();
  loadOpenRooms();
  clearInterval(roomListTimer);
  roomListTimer = setInterval(loadOpenRooms, 2_500);
}

async function loadOpenRooms() {
  if (roomEntry.hidden) return;
  try {
    const { rooms } = await request('/api/rooms');
    openRoomsList.replaceChildren();
    if (!rooms.length) {
      const empty = document.createElement('li');
      empty.className = 'open-rooms-empty';
      empty.textContent = 'no rooms open';
      openRoomsList.append(empty);
      return;
    }
    rooms.forEach((room) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const name = document.createElement('span');
      const count = document.createElement('b');
      name.textContent = `${room.hostName}’s room`;
      count.textContent = `${room.playerCount} / ${room.maxPlayers}`;
      button.append(name, count);
      button.addEventListener('click', () => enterRoom(room.code));
      item.append(button);
      openRoomsList.append(item);
    });
  } catch {
    openRoomsList.innerHTML = '<li class="open-rooms-empty">rooms unavailable</li>';
  }
}

function roomPlayer() {
  return activeRoom?.players.find((player) => player.id === currentPlayer?.id);
}

function renderStandings() {
  if (!activeRoom) return;
  standingsCode.textContent = activeRoom.code;
  standingsList.replaceChildren();
  activeRoom.players.forEach((player, index) => {
    const row = document.createElement('li');
    if (player.id === currentPlayer.id) row.classList.add('you');
    const place = document.createElement('span');
    const name = document.createElement('b');
    const points = document.createElement('strong');
    place.textContent = String(index + 1).padStart(2, '0');
    name.textContent = player.id === currentPlayer.id ? `${player.displayName} · you` : player.displayName;
    points.textContent = `${player.score} · ${player.wins || 0}w`;
    row.append(place, name, points);
    standingsList.append(row);
  });
}

function startRoomBoard() {
  if (!activeRoom?.board) return;
  if (!roomGameStarted) {
    roomGameStarted = true;
    gameMode = 'room';
    board = activeRoom.board.map((row) => [...row]);
    score = roomPlayer()?.score || 0;
    roomMoveId = 0;
    missedMoves = [];
    hintIndex = -1;
    gameOverEl.hidden = true;
    reviewToolbar.hidden = true;
    roomScreen.hidden = true;
    playArea.hidden = false;
    globalLeaderboard.hidden = true;
    roomStandings.hidden = false;
    document.querySelector('.status').hidden = false;
    document.querySelector('#new-game').hidden = true;
    appShell.classList.add('room-playing');
    playing = true;
    renderBoard();
    clearInterval(timerId);
    timerId = setInterval(tick, 250);
  }
  score = roomPlayer()?.score || score;
  scoreEl.textContent = score;
  renderStandings();
}

function finishRoomBoard() {
  if (!roomGameStarted || !activeRoom) return;
  playing = false;
  clearInterval(timerId);
  if (activeRoom.board) {
    board = activeRoom.board.map((row) => [...row]);
    renderBoard();
  }
  score = roomPlayer()?.score || 0;
  scoreEl.textContent = score;
  finalScoreEl.textContent = score;
  missedMoves = findMissedMoves();
  hintIndex = -1;
  highlightMissedButton.hidden = missedMoves.length === 0;
  reviewToolbar.hidden = true;
  document.querySelector('#play-again').textContent = activeRoom.hostPlayerId === currentPlayer.id ? 'rematch' : 'waiting for host';
  document.querySelector('#play-again').disabled = activeRoom.hostPlayerId !== currentPlayer.id;
  gameOverEl.hidden = false;
  renderStandings();
}

function updateCountdown() {
  if (!activeRoom || activeRoom.status !== 'countdown') return;
  const remaining = Math.max(0, Math.ceil((activeRoom.startsAt - Date.now()) / 1000));
  roomStateEl.textContent = `starting in ${remaining}`;
}

function renderRoomLobby() {
  if (!activeRoom) return;
  roomScreen.hidden = false;
  roomEntry.hidden = true;
  roomLobby.hidden = false;
  playArea.hidden = true;
  globalLeaderboard.hidden = true;
  document.querySelector('.status').hidden = true;
  appShell.classList.remove('room-playing');
  clearInterval(roomListTimer);
  roomCodeEl.textContent = activeRoom.code;
  roomRoster.replaceChildren();
  [...activeRoom.players].sort((a, b) => a.seat - b.seat).forEach((player) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    const state = document.createElement('b');
    name.textContent = player.displayName;
    if (player.id === activeRoom.hostPlayerId) name.append(' · host');
    const wins = `${player.wins || 0} ${player.wins === 1 ? 'win' : 'wins'}`;
    state.textContent = `${wins} · ${player.ready ? 'ready' : 'not ready'}`;
    state.classList.toggle('ready', player.ready);
    row.append(name, state);
    roomRoster.append(row);
  });
  const me = roomPlayer();
  readyRoomButton.textContent = me?.ready ? 'not ready' : 'ready';
  readyRoomButton.disabled = !['open', 'armed'].includes(activeRoom.status);
  armRoomButton.hidden = activeRoom.hostPlayerId !== currentPlayer.id || activeRoom.status !== 'open';
  armRoomButton.disabled = activeRoom.players.length < 1;
  if (activeRoom.status === 'open') roomStateEl.textContent = `${activeRoom.players.length} / ${activeRoom.maxPlayers} players · waiting for host`;
  if (activeRoom.status === 'armed') roomStateEl.textContent = 'room locked · waiting for everyone';
  if (activeRoom.status === 'countdown') {
    updateCountdown();
    clearInterval(roomCountdownTimer);
    roomCountdownTimer = setInterval(updateCountdown, 200);
  }
}

function handleRoomSnapshot(snapshot) {
  activeRoom = snapshot;
  if (['open', 'armed', 'countdown'].includes(snapshot.status)) {
    if (roomGameStarted) {
      roomGameStarted = false;
      gameOverEl.hidden = true;
      roomStandings.hidden = true;
      document.querySelector('#play-again').disabled = false;
      document.querySelector('#play-again').textContent = 'again';
    }
    renderRoomLobby();
  } else if (snapshot.status === 'live') {
    clearInterval(roomCountdownTimer);
    startRoomBoard();
  } else if (snapshot.status === 'finished') {
    finishRoomBoard();
  }
}

function connectRoomSocket(code) {
  roomSocket?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  roomSocket = new WebSocket(`${protocol}//${location.host}/ws?room=${code}&player=${currentPlayer.id}`);
  roomSocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'room') handleRoomSnapshot(message.room);
    if (message.type === 'error') roomError.textContent = message.message;
  });
}

async function enterRoom(code) {
  roomEntryError.textContent = '';
  try {
    const response = await request(`/api/rooms/${code.toUpperCase()}/join`, {
      method: 'POST', body: JSON.stringify({ playerId: currentPlayer.id }),
    });
    activeRoom = response.room;
    setRoomUrl(activeRoom.code);
    connectRoomSocket(activeRoom.code);
    renderRoomLobby();
  } catch (error) {
    roomEntryError.textContent = error.message;
    showRoomEntry();
  }
}

function formatDuration(durationMs) {
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  const tenths = Math.floor((durationMs % 1_000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

async function loadLeaderboard() {
  try {
    const { entries } = await request('/api/leaderboard?limit=10');
    leaderboardEl.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'No verified runs yet.';
      leaderboardEl.append(empty);
      return;
    }
    entries.forEach((entry, index) => {
      const row = document.createElement('li');
      const place = document.createElement('span');
      const name = document.createElement('b');
      const result = document.createElement('strong');
      place.textContent = String(index + 1).padStart(2, '0');
      name.textContent = entry.displayName;
      result.textContent = `${entry.score} · ${formatDuration(entry.durationMs)}`;
      row.append(place, name, result);
      leaderboardEl.append(row);
    });
  } catch {
    leaderboardEl.innerHTML = '<li class="leaderboard-empty">Leaderboard unavailable.</li>';
  }
}

async function startGame() {
  clearInterval(timerId);
  const requestId = ++startRequestId;
  gameMode = 'solo';
  playing = false;
  timerEl.textContent = '—';
  score = 0;
  scoreEl.textContent = score;
  gameOverEl.hidden = true;
  missedMoves = [];
  hintIndex = -1;
  reviewToolbar.hidden = true;
  roomScreen.hidden = true;
  playArea.hidden = false;
  globalLeaderboard.hidden = false;
  roomStandings.hidden = true;
  document.querySelector('.status').hidden = false;
  document.querySelector('#new-game').hidden = false;
  appShell.classList.remove('room-playing');
  clearSelection();
  try {
    const playerId = currentPlayer?.id || localStorage.getItem('fruitbox-player-id');
    const run = await request('/api/runs', { method: 'POST', body: JSON.stringify({ playerId }) });
    if (requestId !== startRequestId) return;
    activeRun = run;
    currentPlayer = activeRun.player;
    localStorage.setItem('fruitbox-player-id', currentPlayer.id);
    board = generateBoard(activeRun.seed);
    moves = [];
    secondsLeft = ROUND_SECONDS;
    startedAt = performance.now();
    playing = true;
    timerEl.textContent = formatTime(secondsLeft);
    renderBoard();
    timerId = setInterval(tick, 250);
  } catch (error) {
    if (requestId !== startRequestId) return;
    playing = false;
    activeRun = null;
    timerEl.textContent = 'offline';
    console.error(error);
  }
}

function pointerPosition(event) {
  const bounds = boardEl.getBoundingClientRect();
  const outsideMargin = 32;
  return {
    x: Math.min(Math.max(event.clientX - bounds.left, -outsideMargin), bounds.width + outsideMargin),
    y: Math.min(Math.max(event.clientY - bounds.top, -outsideMargin), bounds.height + outsideMargin),
  };
}

boardFrameEl.addEventListener('pointerdown', (event) => {
  if (!playing || event.target.closest('.game-over button')) return;
  event.preventDefault();
  boardFrameEl.setPointerCapture(event.pointerId);
  selectionStart = pointerPosition(event);
  updateSelection(selectionStart);
});

boardFrameEl.addEventListener('pointermove', (event) => {
  if (!selectionStart) return;
  updateSelection(pointerPosition(event));
});

function finishSelection(event) {
  if (!selectionStart || !currentSelection) return;
  updateSelection(pointerPosition(event));
  const { total, selected } = selectionInfo(currentSelection);
  if (total === 10 && selected.length > 0) {
    selected.forEach(({ row, col }) => {
      board[row][col] = null;
      cells[row][col].textContent = '';
      cells[row][col].disabled = true;
      cells[row][col].classList.add('cleared');
    });
    score += selected.length;
    scoreEl.textContent = score;
    moves.push({ at: Math.min(Math.round(performance.now() - startedAt), ROUND_MS), cells: selected });
    if (gameMode === 'room') {
      roomMoveId += 1;
      roomSocket?.send(JSON.stringify({ type: 'move', moveId: roomMoveId, cells: selected }));
    } else if (score === BOARD_SIZE) endGame();
  }
  clearSelection();
}

async function submitRun() {
  if (!activeRun || submitting) return;
  const run = activeRun;
  activeRun = null;
  submitting = true;
  try {
    await request(`/api/runs/${run.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ token: run.token, moves }),
    });
    await loadLeaderboard();
  } catch (error) {
    console.error(error);
  } finally {
    submitting = false;
  }
}

boardFrameEl.addEventListener('pointerup', finishSelection);
boardFrameEl.addEventListener('pointercancel', clearSelection);
document.querySelector('#new-game').addEventListener('click', startGame);
document.querySelector('#play-again').addEventListener('click', async () => {
  if (gameMode !== 'room') return startGame();
  return requestRoomRematch();
});
document.querySelector('#close-results').addEventListener('click', () => {
  gameOverEl.hidden = true;
  renderReviewToolbar();
});
highlightMissedButton.addEventListener('click', () => {
  gameOverEl.hidden = true;
  showMissedMove();
});
showMissedButton.addEventListener('click', () => showMissedMove());
nextMissedButton.addEventListener('click', () => showMissedMove(hintIndex + 1));
hideMissedButton.addEventListener('click', hideMissedMove);
reviewRematchButton.addEventListener('click', requestRoomRematch);
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || usernameDialog.open || gameMode === 'room') return;
  event.preventDefault();
  startGame();
});
usernameDialog.addEventListener('cancel', (event) => event.preventDefault());
usernameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  usernameError.textContent = '';
  const displayName = usernameInput.value;
  try {
    currentPlayer = currentPlayer
      ? await request(`/api/players/${currentPlayer.id}`, { method: 'PATCH', body: JSON.stringify({ displayName }) })
      : await request('/api/players', { method: 'POST', body: JSON.stringify({ displayName }) });
    localStorage.setItem('fruitbox-player-id', currentPlayer.id);
    usernameDialog.close();
    routeAfterPlayer();
  } catch (error) {
    usernameError.textContent = error.message;
  }
});

async function initializePlayer() {
  const playerId = localStorage.getItem('fruitbox-player-id');
  if (playerId) {
    try {
      currentPlayer = await request(`/api/players/${playerId}`);
    } catch {
      localStorage.removeItem('fruitbox-player-id');
    }
  }
  if (!currentPlayer || currentPlayer.displayName.startsWith('player-')) {
    usernameInput.value = '';
    usernameDialog.showModal();
    setTimeout(() => usernameInput.focus(), 0);
    return;
  }
  routeAfterPlayer();
}

function routeAfterPlayer() {
  const roomMatch = location.pathname.match(/^\/room\/([A-Z0-9]{6})$/i);
  if (roomMatch) return enterRoom(roomMatch[1]);
  if (location.pathname === '/room') return showRoomEntry();
  startGame();
}

async function requestRoomRematch() {
  if (activeRoom?.hostPlayerId !== currentPlayer.id || activeRoom.status !== 'finished') return;
  roomError.textContent = '';
  try {
    await request(`/api/rooms/${activeRoom.code}/rematch`, {
      method: 'POST', body: JSON.stringify({ playerId: currentPlayer.id }),
    });
  } catch (error) {
    roomError.textContent = error.message;
  }
}

document.querySelector('#room-nav').addEventListener('click', showRoomEntry);
document.querySelector('#refresh-rooms').addEventListener('click', loadOpenRooms);
document.querySelector('#create-room').addEventListener('click', async () => {
  roomEntryError.textContent = '';
  try {
    const response = await request('/api/rooms', {
      method: 'POST', body: JSON.stringify({ playerId: currentPlayer.id }),
    });
    activeRoom = response.room;
    setRoomUrl(activeRoom.code);
    connectRoomSocket(activeRoom.code);
    renderRoomLobby();
  } catch (error) {
    roomEntryError.textContent = error.message;
  }
});
document.querySelector('#join-room-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = document.querySelector('#room-code-input').value.trim();
  if (code) enterRoom(code);
});
document.querySelector('#copy-room').addEventListener('click', async () => {
  await navigator.clipboard.writeText(`${location.origin}/room/${activeRoom.code}`);
  document.querySelector('#copy-room').textContent = 'copied';
  setTimeout(() => { document.querySelector('#copy-room').textContent = 'copy link'; }, 1200);
});
readyRoomButton.addEventListener('click', async () => {
  roomError.textContent = '';
  try {
    await request(`/api/rooms/${activeRoom.code}/ready`, {
      method: 'POST', body: JSON.stringify({ playerId: currentPlayer.id, ready: !roomPlayer()?.ready }),
    });
  } catch (error) { roomError.textContent = error.message; }
});
armRoomButton.addEventListener('click', async () => {
  roomError.textContent = '';
  try {
    await request(`/api/rooms/${activeRoom.code}/arm`, {
      method: 'POST', body: JSON.stringify({ playerId: currentPlayer.id }),
    });
  } catch (error) { roomError.textContent = error.message; }
});
window.addEventListener('popstate', () => location.reload());

loadLeaderboard();
initializePlayer();
