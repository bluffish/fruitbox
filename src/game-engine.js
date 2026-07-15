export const ROWS = 10;
export const COLS = 17;
export const BOARD_SIZE = ROWS * COLS;
export const ROUND_MS = 120_000;
export const MIN_MOVE_INTERVAL_MS = 100;
export const SIX_MOVE_BURST_MS = 1_000;
export const NINE_MOVE_BURST_MS = 3_000;

export function validateMoveCadence(moveTimes) {
  if (!Array.isArray(moveTimes) || moveTimes.some((time) => !Number.isInteger(time) || time < 0)) {
    throw new Error('Invalid move timing.');
  }
  for (let index = 1; index < moveTimes.length; index += 1) {
    const current = moveTimes[index];
    if (current < moveTimes[index - 1]) throw new Error('Invalid move timing.');
    if (current - moveTimes[index - 1] < MIN_MOVE_INTERVAL_MS) {
      throw new Error('Moves are arriving too quickly.');
    }
    if (index >= 5 && current - moveTimes[index - 5] < SIX_MOVE_BURST_MS) {
      throw new Error('Too many moves in a short burst.');
    }
    if (index >= 8 && current - moveTimes[index - 8] < NINE_MOVE_BURST_MS) {
      throw new Error('Sustained move rate is too high.');
    }
  }
}

const NUMBER_POOL = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function generateBoard(seed) {
  const random = seededRandom(seed);
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => NUMBER_POOL[Math.floor(random() * NUMBER_POOL.length)]),
  );
}

export function applyMove(board, cells) {
  if (!Array.isArray(cells) || cells.length === 0) throw new Error('Invalid move.');
  const keys = new Set();
  const normalized = cells.map(({ row, col }) => {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
      throw new Error('Invalid move coordinates.');
    }
    const key = `${row}:${col}`;
    if (keys.has(key)) throw new Error('Duplicate move coordinates.');
    if (board[row][col] === null) throw new Error('That apple was already cleared.');
    keys.add(key);
    return { row, col };
  });

  const top = Math.min(...normalized.map((cell) => cell.row));
  const bottom = Math.max(...normalized.map((cell) => cell.row));
  const left = Math.min(...normalized.map((cell) => cell.col));
  const right = Math.max(...normalized.map((cell) => cell.col));
  const expected = [];
  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      if (board[row][col] !== null) expected.push({ row, col });
    }
  }
  if (expected.length !== normalized.length || expected.some(({ row, col }) => !keys.has(`${row}:${col}`))) {
    throw new Error('A move must contain every remaining apple in one rectangle.');
  }

  const total = normalized.reduce((sum, { row, col }) => sum + board[row][col], 0);
  if (total !== 10) throw new Error('A move does not total 10.');
  normalized.forEach(({ row, col }) => { board[row][col] = null; });
  return { cleared: normalized.length, board };
}

export function validateReplay(seed, moves) {
  if (!Array.isArray(moves) || moves.length > BOARD_SIZE) throw new Error('Invalid move list.');
  const board = generateBoard(seed);
  let previousAt = 0;
  let score = 0;

  for (const move of moves) {
    if (!move || !Array.isArray(move.cells) || move.cells.length === 0) throw new Error('Invalid move.');
    if (!Number.isInteger(move.at) || move.at < previousAt || move.at > ROUND_MS) throw new Error('Invalid move time.');
    previousAt = move.at;

    score += applyMove(board, move.cells).cleared;
  }

  return { score, cleared: score === BOARD_SIZE };
}
