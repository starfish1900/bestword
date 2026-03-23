// ═══════════════════════════════════════════════════════════════════════════════
// BestWord/ChosenWord AI Opponent
// Uses GADDAG move generation with adaptive NO WORDS threshold
// and single-pass consonant selection for ChosenWord.
// Four difficulty levels: easy, medium, hard, expert.
// AI does NOT use word history (vocabulary depletion is a human challenge).
// ═══════════════════════════════════════════════════════════════════════════════

const { generateMoves } = require('./movegen');
const game = require('./game');

const AI_TOKEN = 'AI_PLAYER';
const AI_NAME = 'BestWord AI';

// ─── Difficulty: how the AI picks from ranked moves ──────────────────────────
// Easy:   random from top 20
// Medium: random from top 5
// Hard:   always top move
// Expert: always top move + higher NO WORDS threshold (pickier, waits for better)
const DIFFICULTY_CONFIG = {
  easy:   { pickRange: 20, thresholdMult: 0.3, label: 'Easy' },
  medium: { pickRange: 5,  thresholdMult: 0.6, label: 'Medium' },
  hard:   { pickRange: 1,  thresholdMult: 1.0, label: 'Hard' },
  expert: { pickRange: 1,  thresholdMult: 1.2, label: 'Expert' }
};

function getDifficultyConfig(difficulty) {
  return DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.hard;
}

// Pick a move from the ranked list based on difficulty
function pickMove(moves, difficulty) {
  if (moves.length === 0) return null;
  const cfg = getDifficultyConfig(difficulty);
  const range = Math.min(cfg.pickRange, moves.length);
  if (range === 1) return moves[0];
  const idx = Math.floor(Math.random() * range);
  return moves[idx];
}

// ─── Adaptive NO WORDS threshold ─────────────────────────────────────────────
function getNoWordsThreshold(g, aiToken, difficulty) {
  const bagTotal = Object.values(g.bag).reduce((a, b) => a + b, 0);
  const opponent = game.getOpponent(g, aiToken);
  const aiScore = g.players[aiToken].score;
  const oppScore = opponent ? g.players[opponent].score : 0;
  const scoreDiff = aiScore - oppScore;
  const rackSize = g.players[aiToken].rack ? g.players[aiToken].rack.length : 0;
  const cfg = getDifficultyConfig(difficulty);

  // Base threshold from bag size
  let threshold;
  if (bagTotal > 150) {
    threshold = 90;
  } else if (bagTotal > 100) {
    threshold = 70;
  } else if (bagTotal > 60) {
    threshold = 50;
  } else if (bagTotal > 30) {
    threshold = 30;
  } else if (bagTotal > 15) {
    threshold = 15;
  } else {
    threshold = 0;
  }

  // Small rack: lower threshold
  if (rackSize <= 3) {
    threshold = Math.min(threshold, 15);
  } else if (rackSize <= 5) {
    threshold = Math.min(threshold, 35);
  } else if (rackSize <= 7) {
    threshold = Math.min(threshold, 50);
  }

  // Score differential adjustment
  if (scoreDiff < -150) {
    threshold = Math.max(0, threshold - 40);
  } else if (scoreDiff < -80) {
    threshold = Math.max(0, threshold - 20);
  } else if (scoreDiff > 150) {
    threshold += 15;
  }

  // Apply difficulty multiplier
  threshold = Math.round(threshold * cfg.thresholdMult);

  return threshold;
}

// ─── ChosenWord: single-pass consonant selection ─────────────────────────────
function chooseBestConsonants(g, aiToken, gaddag, dawg, difficulty) {
  const player = g.players[aiToken];
  const rackCount = player.rack.length;
  const cfg = game.getLangConfig(g.lang);

  let toChoose = rackCount >= 10 ? 0 : rackCount === 9 ? 1 : 2;
  const availConsonants = game.consonantsInBag(g.bag, g.lang);
  toChoose = Math.min(toChoose, availConsonants);

  if (toChoose === 0) return [];

  // Build super-rack: current rack + all distinct consonants in bag
  const superRack = [...player.rack];
  for (const ch of cfg.consonants) {
    if ((g.bag[ch] || 0) > 0 && !superRack.includes(ch)) {
      superRack.push(ch);
    }
  }

  // Generate moves with super-rack (no word history for AI)
  const result = generateMoves(g.board, superRack, g.bag, gaddag, dawg, g.lang, g.bridgeScoring, null, 5000);

  if (result.moves.length === 0) {
    const available = [];
    for (const ch of cfg.consonants) {
      if ((g.bag[ch] || 0) > 0) available.push(ch);
    }
    if (toChoose === 1) return available.length > 0 ? [available[0]] : [];
    if (available.length < 2) return available;
    return [available[0], available[1]];
  }

  // For each move, determine which new consonants it needs beyond current rack
  const rackMap = {};
  for (const ch of player.rack) rackMap[ch] = (rackMap[ch] || 0) + 1;

  // Collect all valid (pair, score) candidates
  const candidates = [];

  for (const move of result.moves) {
    const rackCopy = { ...rackMap };
    const needed = [];

    let r = move.startRow, c = move.startCol;
    for (let i = 0; i < move.word.length; i++) {
      const ch = move.word[i];
      const onBoard = g.board[r][c] !== null;
      if (!onBoard && cfg.consonants.has(ch)) {
        if ((rackCopy[ch] || 0) > 0) {
          rackCopy[ch]--;
        } else {
          needed.push(ch);
        }
      }
      if (move.direction === 'H') c++; else r++;
    }

    if (needed.length > toChoose) continue;
    if (toChoose === 2 && needed.length === 2 && needed[0] === needed[1]) continue;

    const pair = [...needed];
    if (pair.length < toChoose) {
      for (const ch of cfg.consonants) {
        if (pair.length >= toChoose) break;
        if ((g.bag[ch] || 0) > 0 && !pair.includes(ch)) {
          pair.push(ch);
        }
      }
    }

    if (pair.length !== toChoose) continue;
    if (toChoose === 2 && pair[0] === pair[1]) continue;

    const bagCopy = { ...g.bag };
    let valid = true;
    for (const ch of pair) {
      if ((bagCopy[ch] || 0) <= 0) { valid = false; break; }
      bagCopy[ch]--;
    }
    if (!valid) continue;

    candidates.push({ pair, score: move.totalScore });
    if (candidates.length >= 50) break;
  }

  if (candidates.length === 0) {
    const available = [];
    for (const ch of cfg.consonants) {
      if ((g.bag[ch] || 0) > 0) available.push(ch);
    }
    return available.slice(0, toChoose);
  }

  // Pick based on difficulty
  const diffCfg = getDifficultyConfig(difficulty);
  const range = Math.min(diffCfg.pickRange, candidates.length);
  const idx = range === 1 ? 0 : Math.floor(Math.random() * range);
  return candidates[idx].pair;
}

// ─── AI Turn Execution ───────────────────────────────────────────────────────
async function executeAITurn(g, gameId, gaddag, dawg) {
  const aiToken = AI_TOKEN;
  const player = g.players[aiToken];
  if (!player) return { error: 'AI player not found' };

  const difficulty = g.aiDifficulty || 'hard';

  // ─── Draw Phase ────────────────────────────────────────────────────────────
  if (g.phase === 'draw' && game.getCurrentPlayer(g) === aiToken && !g.drawDone) {
    if (g.variant === 'chosenword') {
      const chosen = chooseBestConsonants(g, aiToken, gaddag, dawg, difficulty);
      const result = game.performChooseConsonants(g, aiToken, chosen);
      if (result.error) {
        if (result.error.code === 'WRONG_CONSONANT_COUNT') {
          game.performChooseConsonants(g, aiToken, []);
        } else {
          return { error: 'AI choose failed: ' + result.error.code };
        }
      }
    } else {
      const result = game.performDraw(g, aiToken);
      if (result.error) return { error: 'AI draw failed: ' + result.error.code };
    }
  }

  // ─── Action Phase ──────────────────────────────────────────────────────────
  if (g.phase === 'action' && game.getCurrentPlayer(g) === aiToken) {
    // No word history for AI — always full vocabulary
    const result = generateMoves(g.board, player.rack, g.bag, gaddag, dawg, g.lang, g.bridgeScoring, null, 10000);

    const threshold = getNoWordsThreshold(g, aiToken, difficulty);
    const selectedMove = pickMove(result.moves, difficulty);
    const opponent = game.getOpponent(g, aiToken);
    const opponentPassed = opponent ? g.players[opponent].passed : false;

    if (selectedMove && selectedMove.totalScore >= threshold) {
      const placeResult = game.performPlaceWord(
        g, aiToken,
        selectedMove.startRow, selectedMove.startCol,
        selectedMove.direction, selectedMove.word,
        dawg
      );
      if (placeResult.error) {
        // Try alternatives from top of list
        for (let i = 0; i < Math.min(20, result.moves.length); i++) {
          const alt = result.moves[i];
          const altResult = game.performPlaceWord(g, aiToken, alt.startRow, alt.startCol, alt.direction, alt.word, dawg);
          if (!altResult.error) {
            return { action: 'PLACE', word: alt.word, score: alt.totalScore };
          }
        }
      } else {
        return { action: 'PLACE', word: selectedMove.word, score: selectedMove.totalScore };
      }
    }

    // Below threshold or no moves
    if (!opponentPassed && g.drewCount > 0) {
      // Consider playing anyway in late game
      const bestMove = result.moves.length > 0 ? result.moves[0] : null;
      if (bestMove && bestMove.totalScore > 0) {
        const bagTotal = Object.values(g.bag).reduce((a, b) => a + b, 0);
        if (bagTotal < 30) {
          const placeResult = game.performPlaceWord(
            g, aiToken,
            bestMove.startRow, bestMove.startCol,
            bestMove.direction, bestMove.word,
            dawg
          );
          if (!placeResult.error) {
            return { action: 'PLACE', word: bestMove.word, score: bestMove.totalScore };
          }
        }
      }
      const noResult = game.performNoWords(g, aiToken);
      if (!noResult.error) {
        return { action: 'NO_WORDS' };
      }
    }

    // Must play or pass
    const bestMove = result.moves.length > 0 ? result.moves[0] : null;
    if (bestMove) {
      const placeResult = game.performPlaceWord(
        g, aiToken,
        bestMove.startRow, bestMove.startCol,
        bestMove.direction, bestMove.word,
        dawg
      );
      if (!placeResult.error) {
        return { action: 'PLACE', word: bestMove.word, score: bestMove.totalScore };
      }
    }

    const passResult = game.performPass(g, aiToken);
    if (!passResult.error) {
      return { action: 'PASS' };
    }

    return { error: 'AI stuck — no legal action' };
  }

  return { error: 'AI not in expected phase' };
}

module.exports = {
  AI_TOKEN,
  AI_NAME,
  DIFFICULTY_CONFIG,
  executeAITurn,
  chooseBestConsonants,
  getNoWordsThreshold,
  pickMove,
  getDifficultyConfig
};
