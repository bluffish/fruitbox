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
  if (!missedMoves.length) {
    reviewToolbar.hidden = true;
    highlightMissedButton.hidden = true;
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
  const elapsed = performance.now() - startedAt;
  secondsLeft = Math.max(0, Math.ceil((ROUND_MS - elapsed) / 1000));
  timerEl.textContent = formatTime(secondsLeft);
  if (secondsLeft <= 0) endGame();
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
  playing = false;
  timerEl.textContent = '—';
  score = 0;
  scoreEl.textContent = score;
  gameOverEl.hidden = true;
  missedMoves = [];
  hintIndex = -1;
  reviewToolbar.hidden = true;
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
    if (score === BOARD_SIZE) endGame();
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
document.querySelector('#play-again').addEventListener('click', startGame);
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
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || usernameDialog.open) return;
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
    startGame();
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
  startGame();
}

loadLeaderboard();
initializePlayer();
