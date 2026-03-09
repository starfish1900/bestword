// BestWord Game Logic

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U', 'Y']);
const CONSONANTS = new Set(['B', 'C', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'X', 'Z']);

const LETTER_VALUES = {
  A: 1, E: 1, I: 1, O: 1,
  U: 2, Y: 2, S: 2,
  N: 3, R: 3,
  T: 4, D: 4,
  M: 5, L: 5,
  C: 6, G: 6, H: 6,
  K: 7, W: 7,
  P: 8, B: 8,
  F: 9, V: 9,
  X: 10, Z: 10,
  J: 11, Q: 11
};

const INITIAL_BAG = {
  A: 16, B: 8, C: 10, D: 8, E: 24, F: 7, G: 10, H: 10,
  I: 16, J: 4, K: 5, L: 8, M: 8, N: 16, O: 10, P: 8,
  Q: 4, R: 16, S: 16, T: 16, U: 8, V: 7, W: 5, X: 4,
  Y: 8, Z: 4
};

function isVowel(ch) { return VOWELS.has(ch); }
function isConsonant(ch) { return CONSONANTS.has(ch); }

function createBag() {
  const bag = {};
  for (const [letter, count] of Object.entries(INITIAL_BAG)) {
    bag[letter] = count;
  }
  return bag;
}

function consonantsInBag(bag) {
  let count = 0;
  for (const ch of CONSONANTS) {
    count += (bag[ch] || 0);
  }
  return count;
}

function drawConsonants(bag, count) {
  const available = [];
  for (const ch of CONSONANTS) {
    for (let i = 0; i < (bag[ch] || 0); i++) {
      available.push(ch);
    }
  }
  // Shuffle
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  const drawn = available.slice(0, Math.min(count, available.length));
  for (const ch of drawn) {
    bag[ch]--;
  }
  return drawn;
}

function consumeFromBag(bag, letter) {
  if ((bag[letter] || 0) > 0) {
    bag[letter]--;
    return true;
  }
  return false;
}

function createBoard() {
  const board = [];
  for (let r = 0; r < 15; r++) {
    board.push(new Array(15).fill(null));
  }
  return board;
}

// Score a principal word: (sum of letter values) * (number of consonants in word)
function scorePrincipalWord(word) {
  let valueSum = 0;
  let consonantCount = 0;
  for (const ch of word) {
    valueSum += (LETTER_VALUES[ch] || 0);
    if (isConsonant(ch)) consonantCount++;
  }
  return valueSum * consonantCount;
}

// Score a secondary word: sum of letter values only
function scoreSecondaryWord(word) {
  let valueSum = 0;
  for (const ch of word) {
    valueSum += (LETTER_VALUES[ch] || 0);
  }
  return valueSum;
}

// Place initial crossing words on the board
function placeInitialWords(board, bag, dawg) {
  // Get words of length 9-12
  const words = dawg.getWordsOfLength(9, 12);
  if (words.length < 2) throw new Error('Not enough words of length 9-12');

  let attempts = 0;
  while (attempts < 1000) {
    attempts++;
    const w1 = words[Math.floor(Math.random() * words.length)];
    const w2 = words[Math.floor(Math.random() * words.length)];
    if (w1 === w2) continue;

    // Find all shared letter positions
    const crossings = [];
    for (let i = 0; i < w1.length; i++) {
      for (let j = 0; j < w2.length; j++) {
        if (w1[i] === w2[j]) {
          crossings.push({ i, j });
        }
      }
    }
    if (crossings.length === 0) continue;

    // Pick a random crossing
    const cross = crossings[Math.floor(Math.random() * crossings.length)];
    // w1 is horizontal, w2 is vertical
    // The crossing point on the board: (crossRow, crossCol)
    // w1 starts at (crossRow, crossCol - cross.i)
    // w2 starts at (crossRow - cross.j, crossCol)

    // Try random board positions for the crossing point
    const validPositions = [];
    for (let cr = 0; cr < 15; cr++) {
      for (let cc = 0; cc < 15; cc++) {
        const w1StartCol = cc - cross.i;
        const w1EndCol = w1StartCol + w1.length - 1;
        const w2StartRow = cr - cross.j;
        const w2EndRow = w2StartRow + w2.length - 1;

        if (w1StartCol >= 0 && w1EndCol < 15 && w2StartRow >= 0 && w2EndRow < 15) {
          validPositions.push({ cr, cc });
        }
      }
    }

    if (validPositions.length === 0) continue;
    const pos = validPositions[Math.floor(Math.random() * validPositions.length)];
    const { cr, cc } = pos;

    const w1StartCol = cc - cross.i;
    const w2StartRow = cr - cross.j;

    // Check we have enough letters in bag
    const letterNeeds = {};
    for (const ch of w1) letterNeeds[ch] = (letterNeeds[ch] || 0) + 1;
    for (const ch of w2) letterNeeds[ch] = (letterNeeds[ch] || 0) + 1;
    // The crossing letter is shared, subtract one
    letterNeeds[w1[cross.i]]--;

    let canPlace = true;
    const tempBag = { ...bag };
    for (const [ch, need] of Object.entries(letterNeeds)) {
      if ((tempBag[ch] || 0) < need) { canPlace = false; break; }
    }
    if (!canPlace) continue;

    // Place w1 horizontally
    for (let k = 0; k < w1.length; k++) {
      board[cr][w1StartCol + k] = w1[k];
    }
    // Place w2 vertically
    for (let k = 0; k < w2.length; k++) {
      board[w2StartRow + k][cc] = w2[k];
    }

    // Consume from bag
    for (const [ch, need] of Object.entries(letterNeeds)) {
      bag[ch] -= need;
    }

    return { word1: w1, word2: w2, word1Row: cr, word1StartCol: w1StartCol, word2Col: cc, word2StartRow: w2StartRow, crossRow: cr, crossCol: cc };
  }

  throw new Error('Could not place initial words after 1000 attempts');
}

// Validate a move: startRow, startCol, direction ('H' or 'V'), word (full word string)
// newTiles: array of {row, col, letter} - the tiles the player is placing
// Returns: { valid, error, principalWord, secondaryWords, totalScore, consonantsUsed, vowelsUsed, newTiles }
function validateMove(board, rack, bag, dawg, startRow, startCol, direction, word, playedPrincipalWords) {
  if (!word || word.length < 3 || word.length > 15) {
    return { valid: false, error: 'Word must be between 3 and 15 letters long' };
  }

  // Determine positions of each letter in the word
  const positions = [];
  let r = startRow, c = startCol;
  for (let i = 0; i < word.length; i++) {
    if (r < 0 || r >= 15 || c < 0 || c >= 15) {
      return { valid: false, error: 'Word goes off the board' };
    }
    positions.push({ row: r, col: c, letter: word[i] });
    if (direction === 'H') c++; else r++;
  }

  // Check that end of word is not followed by an occupied square
  if (direction === 'H' && c < 15 && board[positions[positions.length - 1].row][c] !== null) {
    return { valid: false, error: 'Word does not end properly - adjacent tile exists' };
  }
  if (direction === 'V' && r < 15 && board[r][positions[positions.length - 1].col] !== null) {
    return { valid: false, error: 'Word does not end properly - adjacent tile exists' };
  }

  // Check that start of word is not preceded by an occupied square
  if (direction === 'H' && startCol > 0 && board[startRow][startCol - 1] !== null) {
    return { valid: false, error: 'Word does not start properly - adjacent tile exists before start' };
  }
  if (direction === 'V' && startRow > 0 && board[startRow - 1][startCol] !== null) {
    return { valid: false, error: 'Word does not start properly - adjacent tile exists before start' };
  }

  // Identify new tiles (positions where board is empty) and verify existing tiles match
  const newTiles = [];
  const existingTiles = [];
  for (const pos of positions) {
    if (board[pos.row][pos.col] === null) {
      newTiles.push(pos);
    } else {
      if (board[pos.row][pos.col] !== pos.letter) {
        return { valid: false, error: `Conflict at (${pos.row + 1}, ${String.fromCharCode(65 + pos.col)}): board has ${board[pos.row][pos.col]}, word has ${pos.letter}` };
      }
      existingTiles.push(pos);
    }
  }

  if (newTiles.length < 2) {
    return { valid: false, error: 'Must place at least 2 new tiles' };
  }

  // Separate new tiles into consonants (must come from rack) and vowels (must come from bag)
  const newConsonants = newTiles.filter(t => isConsonant(t.letter));
  const newVowels = newTiles.filter(t => isVowel(t.letter));

  // Check consonants are available on rack
  const rackCopy = [...rack];
  const consonantsUsed = [];
  for (const t of newConsonants) {
    const idx = rackCopy.indexOf(t.letter);
    if (idx === -1) {
      return { valid: false, error: `Consonant ${t.letter} not on your rack` };
    }
    rackCopy.splice(idx, 1);
    consonantsUsed.push(t.letter);
  }

  // Check vowels are available in bag
  const bagCopy = { ...bag };
  const vowelsUsed = [];
  for (const t of newVowels) {
    if ((bagCopy[t.letter] || 0) <= 0) {
      return { valid: false, error: `Vowel ${t.letter} not available in the bag` };
    }
    bagCopy[t.letter]--;
    vowelsUsed.push(t.letter);
  }

  // Check principal word is in dictionary
  if (!dawg.isWord(word)) {
    return { valid: false, error: `"${word}" is not in the dictionary` };
  }

  // Check principal word uniqueness
  if (playedPrincipalWords.has(word)) {
    return { valid: false, error: `"${word}" has already been played as a principal word in this game` };
  }

  // Must connect to existing tiles (at least one existing tile in word OR adjacent to existing tiles)
  const touchesExisting = existingTiles.length > 0 || newTiles.some(t => {
    const { row, col } = t;
    if (row > 0 && board[row - 1][col] !== null) return true;
    if (row < 14 && board[row + 1][col] !== null) return true;
    if (col > 0 && board[row][col - 1] !== null) return true;
    if (col < 14 && board[row][col + 1] !== null) return true;
    return false;
  });

  if (!touchesExisting) {
    return { valid: false, error: 'Word must connect to existing tiles on the board' };
  }

  // Find all secondary words (crosswords formed by new tiles)
  const secondaryWords = [];
  for (const t of newTiles) {
    const crossDir = direction === 'H' ? 'V' : 'H';
    const crossWord = extractWord(board, t.row, t.col, crossDir, newTiles);
    if (crossWord) {
      if (crossWord.length < 3) {
        return { valid: false, error: `Secondary word "${crossWord}" is less than 3 letters` };
      }
      if (crossWord.length > 15) {
        return { valid: false, error: `Secondary word "${crossWord}" exceeds 15 letters` };
      }
      if (!dawg.isWord(crossWord)) {
        return { valid: false, error: `Secondary word "${crossWord}" is not in the dictionary` };
      }
      secondaryWords.push(crossWord);
    }
  }

  // Calculate score
  let totalScore = scorePrincipalWord(word);
  for (const sw of secondaryWords) {
    totalScore += scoreSecondaryWord(sw);
  }

  return {
    valid: true,
    principalWord: word,
    secondaryWords,
    totalScore,
    consonantsUsed,
    vowelsUsed,
    newTiles,
    remainingRack: rackCopy
  };
}

// Extract the full word in a given direction that passes through (row, col)
// considering both existing board tiles and newTiles
function extractWord(board, row, col, direction, newTiles) {
  const newTileMap = new Map();
  for (const t of newTiles) {
    newTileMap.set(`${t.row},${t.col}`, t.letter);
  }

  const getCell = (r, c) => {
    const key = `${r},${c}`;
    if (newTileMap.has(key)) return newTileMap.get(key);
    if (r >= 0 && r < 15 && c >= 0 && c < 15) return board[r][c];
    return null;
  };

  // Find start of word
  let sr = row, sc = col;
  if (direction === 'H') {
    while (sc > 0 && getCell(sr, sc - 1) !== null) sc--;
  } else {
    while (sr > 0 && getCell(sr - 1, sc) !== null) sr--;
  }

  // Read word
  let word = '';
  let r = sr, c = sc;
  while (r < 15 && c < 15 && getCell(r, c) !== null) {
    word += getCell(r, c);
    if (direction === 'H') c++; else r++;
  }

  // Only return if it's more than 1 letter (the tile itself)
  return word.length > 1 ? word : null;
}

// Create a new game state
function createGame(gameId, player1Token, player1Name, dawg, timeControl) {
  const bag = createBag();
  const board = createBoard();
  const initResult = placeInitialWords(board, bag, dawg);

  // timeControl: { minutes: 15, increment: 30 }
  const tc = timeControl || { minutes: 15, increment: 30 };
  const timeMs = tc.minutes * 60 * 1000;

  return {
    id: gameId,
    board,
    bag,
    players: {
      [player1Token]: {
        rack: [],
        score: 0,
        passed: false,
        connected: true,
        disconnectTimer: null,
        name: player1Name,
        timeRemaining: timeMs
      }
    },
    playerOrder: [player1Token],
    currentTurnIndex: 0,
    phase: 'waiting', // waiting, draw, action, finished
    playedPrincipalWords: new Set(),
    moveHistory: [],
    initResult,
    createdAt: Date.now(),
    drawDone: false, // tracks if current player has drawn consonants this turn
    drewCount: 0,    // how many consonants drawn this turn (0 restricts NO WORDS)
    timeControl: tc,
    turnStartedAt: null // timestamp when current player's turn began
  };
}

function addPlayer(game, playerToken, playerName) {
  const timeMs = game.timeControl.minutes * 60 * 1000;
  game.players[playerToken] = {
    rack: [],
    score: 0,
    passed: false,
    connected: true,
    disconnectTimer: null,
    name: playerName,
    timeRemaining: timeMs
  };
  game.playerOrder.push(playerToken);
  game.phase = 'draw';
  game.drawDone = false;
  game.drewCount = 0;
  game.turnStartedAt = Date.now();
}

function getCurrentPlayer(game) {
  return game.playerOrder[game.currentTurnIndex];
}

function getOpponent(game, playerToken) {
  return game.playerOrder.find(t => t !== playerToken);
}

// ─── Clock helpers ─────────────────────────────────────────────────────────────

// Deduct elapsed time from the current player's clock. Returns 'timeout' if they ran out.
function tickClock(game) {
  if (!game.turnStartedAt) return null;
  const current = getCurrentPlayer(game);
  const player = game.players[current];
  const elapsed = Date.now() - game.turnStartedAt;
  player.timeRemaining -= elapsed;
  game.turnStartedAt = Date.now(); // reset for next tick segment
  if (player.timeRemaining <= 0) {
    player.timeRemaining = 0;
    return 'timeout';
  }
  return null;
}

// Add increment to a player's clock after completing a move
function addIncrement(game, playerToken) {
  const player = game.players[playerToken];
  player.timeRemaining += game.timeControl.increment * 1000;
}

// Check if current player has timed out (called by server interval)
function checkTimeout(game) {
  if (game.phase === 'finished' || game.phase === 'waiting') return null;
  if (!game.turnStartedAt) return null;
  const current = getCurrentPlayer(game);
  const player = game.players[current];
  const elapsed = Date.now() - game.turnStartedAt;
  const remaining = player.timeRemaining - elapsed;
  if (remaining <= 0) {
    player.timeRemaining = 0;
    game.turnStartedAt = null;
    game.phase = 'finished';
    return current; // token of the player who timed out
  }
  return null;
}

// Perform the mandatory draw phase
function performDraw(game, playerToken) {
  if (game.phase !== 'draw') return { error: 'Not in draw phase' };
  if (getCurrentPlayer(game) !== playerToken) return { error: 'Not your turn' };
  if (game.drawDone) return { error: 'Already drew this turn' };

  // Tick clock
  if (tickClock(game) === 'timeout') return { error: 'timeout' };

  const player = game.players[playerToken];
  const rackCount = player.rack.length;
  const availableConsonants = consonantsInBag(game.bag);

  let toDraw = 0;
  if (rackCount >= 8) {
    // Rack full: skip draw
    toDraw = 0;
  } else if (rackCount === 7) {
    // Draw 1 if available
    toDraw = Math.min(1, availableConsonants);
  } else {
    // 6 or fewer: draw 2 if available, else 1, else 0
    toDraw = Math.min(2, availableConsonants);
  }

  const drawn = toDraw > 0 ? drawConsonants(game.bag, toDraw) : [];
  player.rack.push(...drawn);

  game.drawDone = true;
  game.drewCount = drawn.length; // track how many were drawn this turn
  game.phase = 'action';
  return { drawn, rackCount: player.rack.length };
}

// Advance to next turn
function advanceTurn(game) {
  // Tick clock and add increment for the player who just acted
  tickClock(game);
  const actingPlayer = getCurrentPlayer(game);
  addIncrement(game, actingPlayer);

  // Check if game is over
  const p1 = game.players[game.playerOrder[0]];
  const p2 = game.players[game.playerOrder[1]];
  if (p1.passed && p2.passed) {
    game.phase = 'finished';
    game.turnStartedAt = null;
    return;
  }

  // Find next non-passed player
  game.currentTurnIndex = (game.currentTurnIndex + 1) % 2;
  const nextPlayer = game.players[getCurrentPlayer(game)];
  if (nextPlayer.passed) {
    game.currentTurnIndex = (game.currentTurnIndex + 1) % 2;
  }

  game.phase = 'draw';
  game.drawDone = false;
  game.drewCount = 0;
  game.turnStartedAt = Date.now();
}

function performPass(game, playerToken) {
  if (game.phase !== 'action') return { error: 'Not in action phase' };
  if (getCurrentPlayer(game) !== playerToken) return { error: 'Not your turn' };
  if (tickClock(game) === 'timeout') return { error: 'timeout' };

  const player = game.players[playerToken];
  player.passed = true;
  game.moveHistory.push({ player: playerToken, action: 'PASS' });

  advanceTurn(game);
  return { success: true };
}

function performNoWords(game, playerToken) {
  if (game.phase !== 'action') return { error: 'Not in action phase' };
  if (getCurrentPlayer(game) !== playerToken) return { error: 'Not your turn' };
  if (tickClock(game) === 'timeout') return { error: 'timeout' };

  // Check if opponent has passed - if so, cannot declare NO WORDS
  const opponent = getOpponent(game, playerToken);
  if (game.players[opponent].passed) {
    return { error: 'Cannot declare NO WORDS after opponent has passed. You must play a word or PASS.' };
  }

  // If player drew 0 consonants this turn (bag empty or rack was full), cannot declare NO WORDS
  if (game.drewCount === 0) {
    return { error: 'Cannot declare NO WORDS when you did not draw any consonants. You must play a word or PASS.' };
  }

  game.moveHistory.push({ player: playerToken, action: 'NO_WORDS' });
  advanceTurn(game);
  return { success: true };
}

function performPlaceWord(game, playerToken, startRow, startCol, direction, word, dawg) {
  if (game.phase !== 'action') return { error: 'Not in action phase' };
  if (getCurrentPlayer(game) !== playerToken) return { error: 'Not your turn' };
  if (tickClock(game) === 'timeout') return { error: 'timeout' };

  const player = game.players[playerToken];

  const result = validateMove(
    game.board, player.rack, game.bag, dawg,
    startRow, startCol, direction, word.toUpperCase(),
    game.playedPrincipalWords
  );

  if (!result.valid) return { error: result.error };

  // Apply move
  for (const t of result.newTiles) {
    game.board[t.row][t.col] = t.letter;
  }

  // Remove consonants from rack
  player.rack = result.remainingRack;

  // Remove vowels from bag
  for (const v of result.vowelsUsed) {
    game.bag[v]--;
  }

  // Update score
  player.score += result.totalScore;

  // Record principal word
  game.playedPrincipalWords.add(result.principalWord);

  // Record move
  game.moveHistory.push({
    player: playerToken,
    action: 'PLACE',
    startRow,
    startCol,
    direction,
    word: result.principalWord,
    secondaryWords: result.secondaryWords,
    score: result.totalScore,
    newTiles: result.newTiles
  });

  advanceTurn(game);

  return {
    success: true,
    principalWord: result.principalWord,
    secondaryWords: result.secondaryWords,
    score: result.totalScore,
    newTiles: result.newTiles
  };
}

function getGameResult(game) {
  const p1Token = game.playerOrder[0];
  const p2Token = game.playerOrder[1];
  const p1 = game.players[p1Token];
  const p2 = game.players[p2Token];

  if (p1.score > p2.score) return { winner: p1Token, loser: p2Token, reason: 'score' };
  if (p2.score > p1.score) return { winner: p2Token, loser: p1Token, reason: 'score' };
  return { winner: null, loser: null, reason: 'draw' };
}

// Get sanitized game state for a specific player
function getGameState(game, playerToken) {
  const opponent = getOpponent(game, playerToken);
  const currentPlayer = getCurrentPlayer(game);

  // Compute live time remaining
  const elapsed = (game.turnStartedAt && game.phase !== 'finished' && game.phase !== 'waiting')
    ? Date.now() - game.turnStartedAt : 0;
  const myTimeRaw = game.players[playerToken] ? game.players[playerToken].timeRemaining : 0;
  const oppTimeRaw = (opponent && game.players[opponent]) ? game.players[opponent].timeRemaining : 0;
  const myTime = currentPlayer === playerToken ? Math.max(0, myTimeRaw - elapsed) : myTimeRaw;
  const oppTime = currentPlayer === opponent ? Math.max(0, oppTimeRaw - elapsed) : oppTimeRaw;

  return {
    id: game.id,
    board: game.board,
    phase: game.phase,
    drawDone: game.drawDone,
    drewCount: game.drewCount,
    myRack: game.players[playerToken] ? game.players[playerToken].rack : [],
    myScore: game.players[playerToken] ? game.players[playerToken].score : 0,
    opponentScore: opponent && game.players[opponent] ? game.players[opponent].score : 0,
    opponentRackSize: opponent && game.players[opponent] ? game.players[opponent].rack.length : 0,
    isMyTurn: currentPlayer === playerToken,
    myPassed: game.players[playerToken] ? game.players[playerToken].passed : false,
    opponentPassed: opponent && game.players[opponent] ? game.players[opponent].passed : false,
    moveHistory: game.moveHistory.map(m => ({
      action: m.action,
      isMe: m.player === playerToken,
      word: m.word,
      secondaryWords: m.secondaryWords,
      score: m.score,
      startRow: m.startRow,
      startCol: m.startCol,
      direction: m.direction
    })),
    bag: { ...game.bag },
    bagTotal: Object.values(game.bag).reduce((a, b) => a + b, 0),
    playerIndex: game.playerOrder.indexOf(playerToken),
    opponentConnected: opponent && game.players[opponent] ? game.players[opponent].connected : true,
    opponentName: opponent && game.players[opponent] ? game.players[opponent].name : '',
    myName: game.players[playerToken] ? game.players[playerToken].name : '',
    myTime,
    oppTime,
    timeControl: game.timeControl,
    serverTime: Date.now()
  };
}

module.exports = {
  VOWELS, CONSONANTS, LETTER_VALUES, INITIAL_BAG,
  isVowel, isConsonant, createBag, createBoard, scorePrincipalWord, scoreSecondaryWord,
  placeInitialWords, validateMove, createGame, addPlayer,
  getCurrentPlayer, getOpponent, performDraw, advanceTurn,
  performPass, performNoWords, performPlaceWord,
  getGameResult, getGameState, consonantsInBag, checkTimeout
};
