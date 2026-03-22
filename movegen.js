// ═══════════════════════════════════════════════════════════════════════════════
// Move Generator — Enumerates all legal BestWord/ChosenWord placements
// Uses a GADDAG for efficient anchor-based generation.
// ═══════════════════════════════════════════════════════════════════════════════

const { SEP } = require('./gaddag');
const { getLangConfig, isVowel, isConsonant, scorePrincipalWord, scoreSecondaryWord, computeBridgeSpans } = require('./game');

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U', 'Y']);
const ALL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['Ç', 'Ñ']);

// ─── Cross-check computation ──────────────────────────────────────────────────
// For each empty cell, compute which letters can be placed there without
// creating an invalid perpendicular (secondary) word.
// Returns checks[r][c] = { h: Set|null, v: Set|null }
// null means any letter is valid (no perpendicular constraint).

function computeCrossChecks(board, dawg) {
  const checks = Array.from({ length: 15 }, () =>
    Array.from({ length: 15 }, () => ({ h: null, v: null }))
  );

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (board[r][c] !== null) continue;

      // Horizontal placement → check vertical cross-word
      let above = '', below = '';
      for (let rr = r - 1; rr >= 0 && board[rr][c] !== null; rr--) above = board[rr][c] + above;
      for (let rr = r + 1; rr < 15 && board[rr][c] !== null; rr++) below += board[rr][c];
      if (above.length > 0 || below.length > 0) {
        const valid = new Set();
        for (const L of ALL_LETTERS) {
          const word = above + L + below;
          if (word.length >= 3 && word.length <= 15 && dawg.isWord(word)) valid.add(L);
        }
        checks[r][c].h = valid;
      }

      // Vertical placement → check horizontal cross-word
      let left = '', right = '';
      for (let cc = c - 1; cc >= 0 && board[r][cc] !== null; cc--) left = board[r][cc] + left;
      for (let cc = c + 1; cc < 15 && board[r][cc] !== null; cc++) right += board[r][cc];
      if (left.length > 0 || right.length > 0) {
        const valid = new Set();
        for (const L of ALL_LETTERS) {
          const word = left + L + right;
          if (word.length >= 3 && word.length <= 15 && dawg.isWord(word)) valid.add(L);
        }
        checks[r][c].v = valid;
      }
    }
  }
  return checks;
}

// ─── Find anchors ──────────────────────────────────────────────────────────────
// An anchor is an empty cell adjacent (orthogonally) to at least one occupied cell.

function findAnchors(board) {
  const anchors = [];
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (board[r][c] !== null) continue;
      if ((r > 0 && board[r - 1][c] !== null) ||
          (r < 14 && board[r + 1][c] !== null) ||
          (c > 0 && board[r][c - 1] !== null) ||
          (c < 14 && board[r][c + 1] !== null)) {
        anchors.push({ r, c });
      }
    }
  }
  return anchors;
}

// ─── Compute secondary words and scores for a candidate move ──────────────────

function computeSecondaries(board, newTiles, dir, lang, bridgeScoring) {
  const secondaries = [];
  const perpDir = dir === 'H' ? 'V' : 'H';

  for (const { row, col, letter } of newTiles) {
    // Walk perpendicular direction to find full word
    let word = letter;
    const positions = [{ row, col }];

    if (perpDir === 'V') {
      // Walk up
      for (let rr = row - 1; rr >= 0 && board[rr][col] !== null; rr--) {
        word = board[rr][col] + word;
        positions.unshift({ row: rr, col });
      }
      // Walk down
      for (let rr = row + 1; rr < 15 && board[rr][col] !== null; rr++) {
        word += board[rr][col];
        positions.push({ row: rr, col });
      }
    } else {
      // Walk left
      for (let cc = col - 1; cc >= 0 && board[row][cc] !== null; cc--) {
        word = board[row][cc] + word;
        positions.unshift({ row, col: cc });
      }
      // Walk right
      for (let cc = col + 1; cc < 15 && board[row][cc] !== null; cc++) {
        word += board[row][cc];
        positions.push({ row, col: cc });
      }
    }

    if (word.length < 2) continue; // no secondary word formed

    const nSpans = bridgeScoring ? computeBridgeSpans(board, positions) : 0;
    const isBridge = nSpans > 0;
    const score = scoreSecondaryWord(word, lang, isBridge);
    secondaries.push({ word, score, isBridge });
  }
  return secondaries;
}

// ─── Main move generator ─────────────────────────────────────────────────────

function generateMoves(board, rack, bag, gaddag, dawg, lang, bridgeScoring, wordHistory) {
  const t0 = Date.now();
  const cfg = getLangConfig(lang);
  const crossChecks = computeCrossChecks(board, dawg);
  const anchors = findAnchors(board);

  // Build rack count map
  const rackMap = {};
  for (const ch of rack) rackMap[ch] = (rackMap[ch] || 0) + 1;

  // Bag copy
  const bagMap = { ...bag };

  // Results (deduplication by key)
  const seen = new Set();
  const rawMoves = [];

  // Blocked words (ChosenWord history)
  const blocked = wordHistory ? new Set(wordHistory) : null;

  // ─── Direction-abstracted helpers ──────────────────────────────────────────
  function generate(dir) {
    // dir = 'H' or 'V'
    // For H: fixed = row, pos = col
    // For V: fixed = col, pos = row

    const getCell = (fixed, pos) => {
      const r = dir === 'H' ? fixed : pos;
      const c = dir === 'H' ? pos : fixed;
      if (r < 0 || r >= 15 || c < 0 || c >= 15) return undefined;
      return board[r][c];
    };

    const getCross = (fixed, pos) => {
      const r = dir === 'H' ? fixed : pos;
      const c = dir === 'H' ? pos : fixed;
      if (r < 0 || r >= 15 || c < 0 || c >= 15) return null;
      return dir === 'H' ? crossChecks[r][c].h : crossChecks[r][c].v;
    };

    const posToRC = (fixed, pos) => {
      return dir === 'H' ? { row: fixed, col: pos } : { row: pos, col: fixed };
    };

    // Try placing a letter at (fixed, pos). Returns true if placed.
    function tryPlace(pos, fixed, letter) {
      const cc = getCross(fixed, pos);
      if (cc !== null && !cc.has(letter)) return false;
      if (cfg.consonants.has(letter)) {
        if ((rackMap[letter] || 0) <= 0) return false;
        rackMap[letter]--;
        return true;
      }
      if (VOWELS.has(letter)) {
        if ((bagMap[letter] || 0) <= 0) return false;
        bagMap[letter]--;
        return true;
      }
      return false;
    }

    function unplace(letter) {
      if (cfg.consonants.has(letter)) rackMap[letter] = (rackMap[letter] || 0) + 1;
      else if (VOWELS.has(letter)) bagMap[letter] = (bagMap[letter] || 0) + 1;
    }

    function recordMove(fixed, startPos, wordChars, newTilePositions) {
      const word = wordChars.join('');
      if (word.length < 3 || word.length > 15 || newTilePositions.length < 2) return;
      const endPos = startPos + word.length;

      // Bounds check: all positions must be on board
      if (startPos < 0 || endPos > 15 || fixed < 0 || fixed >= 15) return;

      // Verify word boundaries
      const before = getCell(fixed, startPos - 1);
      if (before !== null && before !== undefined) return;
      const after = getCell(fixed, endPos);
      if (after !== null && after !== undefined) return;

      const rc = posToRC(fixed, startPos);
      const key = `${rc.row},${rc.col},${dir},${word}`;
      if (seen.has(key)) return;
      seen.add(key);

      // Check blocked words (ChosenWord history)
      if (blocked && blocked.has(word)) return;

      rawMoves.push({
        startRow: rc.row,
        startCol: rc.col,
        direction: dir,
        word,
        newTiles: newTilePositions.map(p => {
          const trc = posToRC(fixed, p.pos);
          return { row: trc.row, col: trc.col, letter: p.letter };
        })
      });
    }

    // ─── GADDAG traversal ───────────────────────────────────────────────────

    function extendRight(fixed, pos, nodeIdx, wordChars, newTiles, anchorPos) {
      // Current node might be terminal → record word
      // (terminal flag was checked by caller via the arc leading here)
      // We check at the START of extendRight: if we were told this is terminal

      // Try extending further right
      if (pos >= 15 || (dir === 'V' && pos >= 15)) return;
      const cell = getCell(fixed, pos);

      if (cell === undefined) return; // off board
      if (cell !== null) {
        // Occupied: follow this letter
        const result = gaddag.getChild(nodeIdx, cell);
        if (result) {
          wordChars.push(cell);
          if (result.terminal) {
            recordMove(fixed, anchorPos - (wordChars.length - 1 - (wordChars.length - wordChars.indexOf(cell) - 1)), wordChars, newTiles);
          }
          extendRight(fixed, pos + 1, result.index, wordChars, newTiles, anchorPos);
          wordChars.pop();
        }
      } else {
        // Empty: try each valid letter
        gaddag.forEachChild(nodeIdx, (letter, childIdx, terminal) => {
          if (letter === SEP) return;
          if (!tryPlace(pos, fixed, letter)) return;
          wordChars.push(letter);
          newTiles.push({ pos, letter });
          if (terminal) {
            const startPos = anchorPos - (wordChars.length - 1 - (pos - anchorPos));
            recordMove(fixed, startPos, wordChars, newTiles);
          }
          extendRight(fixed, pos + 1, childIdx, wordChars, newTiles, anchorPos);
          wordChars.pop();
          newTiles.pop();
          unplace(letter);
        });
      }
    }

    function extendLeft(fixed, pos, nodeIdx, wordLeft, newTiles, anchorPos) {
      // Check separator → switch to going right
      const sepResult = gaddag.getChild(nodeIdx, SEP);
      if (sepResult) {
        // Build word: reversed wordLeft = actual left-to-right order
        const wordChars = wordLeft.slice().reverse();
        const startPos = anchorPos - wordLeft.length + 1;

        // If separator target is terminal, the word is complete (left part only after separator)
        if (sepResult.terminal) {
          recordMove(fixed, startPos, wordChars, newTiles);
        }

        // Continue right from anchorPos + 1
        extendRight(fixed, anchorPos + 1, sepResult.index, wordChars, newTiles.slice(), anchorPos);
      }

      // Check terminal (complete reversal — word is entirely left of/at anchor)
      // This is handled by checking terminal on arcs that led us here

      // Try extending further left
      if (pos < 0) return;
      const cell = getCell(fixed, pos);
      if (cell === undefined) return;

      if (cell !== null) {
        // Occupied: follow this letter
        const result = gaddag.getChild(nodeIdx, cell);
        if (result) {
          wordLeft.push(cell);
          if (result.terminal) {
            // Complete reversal: word = wordLeft reversed
            const startPos = anchorPos - wordLeft.length + 1;
            recordMove(fixed, startPos, wordLeft.slice().reverse(), newTiles);
          }
          extendLeft(fixed, pos - 1, result.index, wordLeft, newTiles, anchorPos);
          wordLeft.pop();
        }
      } else {
        // Empty: try each valid letter
        gaddag.forEachChild(nodeIdx, (letter, childIdx, terminal) => {
          if (letter === SEP) return;
          if (!tryPlace(pos, fixed, letter)) return;
          wordLeft.push(letter);
          newTiles.push({ pos, letter });
          if (terminal) {
            const startPos = anchorPos - wordLeft.length + 1;
            recordMove(fixed, startPos, wordLeft.slice().reverse(), newTiles);
          }
          extendLeft(fixed, pos - 1, childIdx, wordLeft, newTiles, anchorPos);
          wordLeft.pop();
          newTiles.pop();
          unplace(letter);
        });
      }
    }

    // ─── Generate from each anchor ───────────────────────────────────────────

    for (const anchor of anchors) {
      const fixed = dir === 'H' ? anchor.r : anchor.c;
      const anchorPos = dir === 'H' ? anchor.c : anchor.r;

      // The anchor cell must be empty (guaranteed by findAnchors)
      // Try each letter at the anchor position
      gaddag.forEachChild(gaddag.rootIndex, (letter, childIdx, terminal) => {
        if (letter === SEP) return;
        if (!tryPlace(anchorPos, fixed, letter)) return;

        const wordLeft = [letter];
        const newTiles = [{ pos: anchorPos, letter }];

        // Terminal at anchor (single letter): too short, skip recording
        // But continue traversal

        // Extend left from anchorPos - 1
        extendLeft(fixed, anchorPos - 1, childIdx, wordLeft, newTiles, anchorPos);

        wordLeft.pop();
        newTiles.pop();
        unplace(letter);
      });
    }
  }

  // Generate for both directions
  generate('H');
  generate('V');

  // ─── Score all candidate moves ──────────────────────────────────────────────
  const scoredMoves = [];
  for (const move of rawMoves) {
    // Compute principal word positions for bridge detection
    const positions = [];
    let r = move.startRow, c = move.startCol;
    let offBoard = false;
    for (let i = 0; i < move.word.length; i++) {
      if (r < 0 || r >= 15 || c < 0 || c >= 15) { offBoard = true; break; }
      positions.push({ row: r, col: c });
      if (move.direction === 'H') c++; else r++;
    }
    if (offBoard) continue;
    const nSpans = bridgeScoring ? computeBridgeSpans(board, positions) : 0;
    const principalScore = scorePrincipalWord(move.word, lang, nSpans);

    // Compute secondary words and scores
    const secondaries = computeSecondaries(board, move.newTiles, move.direction, lang, bridgeScoring);
    const secondaryScore = secondaries.reduce((sum, s) => sum + s.score, 0);
    const totalScore = principalScore + secondaryScore;

    scoredMoves.push({
      startRow: move.startRow,
      startCol: move.startCol,
      direction: move.direction,
      word: move.word,
      principalScore,
      secondaryWords: secondaries.map(s => s.word),
      secondaryScore,
      totalScore,
      newTileCount: move.newTiles.length
    });
  }

  // Sort by total score descending, then by word alphabetically
  scoredMoves.sort((a, b) => b.totalScore - a.totalScore || a.word.localeCompare(b.word));

  const elapsed = Date.now() - t0;
  return { moves: scoredMoves, elapsed, candidateCount: rawMoves.length };
}

module.exports = { generateMoves, computeCrossChecks, findAnchors };
