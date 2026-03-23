// ═══════════════════════════════════════════════════════════════════════════════
// BestWord/ChosenWord AI Opponent
// Uses GADDAG move generation with adaptive NO WORDS threshold
// and single-pass consonant selection for ChosenWord.
// ═══════════════════════════════════════════════════════════════════════════════

const { generateMoves } = require('./movegen');
const game = require('./game');

const AI_TOKEN = 'AI_PLAYER';
const AI_NAME = 'BestWord AI';

// ─── Adaptive NO WORDS threshold ─────────────────────────────────────────────
// Based on bag size and score differential
function getNoWordsThreshold(g, aiToken) {
  const bagTotal = Object.values(g.bag).reduce((a, b) => a + b, 0);
  const opponent = game.getOpponent(g, aiToken);
  const aiScore = g.players[aiToken].score;
  const oppScore = opponent ? g.players[opponent].score : 0;
  const scoreDiff = aiScore - oppScore; // positive = AI ahead
  const rackSize = g.players[aiToken].rack ? g.players[aiToken].rack.length : 0;

  // Base threshold from bag size
  let threshold;
  if (bagTotal > 150) {
    threshold = 90;       // Opening: be selective
  } else if (bagTotal > 100) {
    threshold = 70;       // Early midgame
  } else if (bagTotal > 60) {
    threshold = 50;       // Midgame
  } else if (bagTotal > 30) {
    threshold = 30;       // Late game
  } else if (bagTotal > 15) {
    threshold = 15;       // Endgame
  } else {
    threshold = 0;        // Final tiles: play anything
  }

  // Small rack: lower threshold — first few turns have limited options
  if (rackSize <= 3) {
    threshold = Math.min(threshold, 15);
  } else if (rackSize <= 5) {
    threshold = Math.min(threshold, 35);
  } else if (rackSize <= 7) {
    threshold = Math.min(threshold, 50);
  }

  // Adjust for score differential
  if (scoreDiff < -150) {
    threshold = Math.max(0, threshold - 40);
  } else if (scoreDiff < -80) {
    threshold = Math.max(0, threshold - 20);
  } else if (scoreDiff > 150) {
    threshold += 15;
  }

  return threshold;
}

// ─── ChosenWord: single-pass consonant selection ─────────────────────────────
// Build super-rack, generate all possible moves, group by consonant pair needed,
// pick the pair that yields the highest-scoring move.
function chooseBestConsonants(g, aiToken, gaddag, dawg, wordHistory) {
  const player = g.players[aiToken];
  const rackCount = player.rack.length;
  const cfg = game.getLangConfig(g.lang);

  // Determine how many to choose
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

  // Generate all possible moves with super-rack
  const result = generateMoves(g.board, superRack, g.bag, gaddag, dawg, g.lang, g.bridgeScoring, wordHistory);

  if (result.moves.length === 0) {
    // No moves possible with any consonants — pick any two available
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

  let bestPair = null;
  let bestScore = -1;

  for (const move of result.moves) {
    // Find consonants in new tiles that aren't on the current rack
    const rackCopy = { ...rackMap };
    const needed = [];

    for (const word of [move.word]) {
      // Walk through the word and check new tiles
      let r = move.startRow, c = move.startCol;
      for (let i = 0; i < word.length; i++) {
        const ch = word[i];
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
    }

    // Check if needed consonants match the toChoose requirement
    if (needed.length > toChoose) continue;
    if (toChoose === 2 && needed.length === 2 && needed[0] === needed[1]) continue; // no duplicates

    // Pad with any available consonant if needed < toChoose
    const pair = [...needed];
    if (pair.length < toChoose) {
      for (const ch of cfg.consonants) {
        if (pair.length >= toChoose) break;
        if ((g.bag[ch] || 0) > 0 && !pair.includes(ch)) {
          pair.push(ch);
        }
      }
    }

    if (pair.length === toChoose && move.totalScore > bestScore) {
      // Verify no duplicates for toChoose === 2
      if (toChoose === 2 && pair[0] === pair[1]) continue;
      // Verify all are available in bag
      const bagCopy = { ...g.bag };
      let valid = true;
      for (const ch of pair) {
        if ((bagCopy[ch] || 0) <= 0) { valid = false; break; }
        bagCopy[ch]--;
      }
      if (!valid) continue;

      bestScore = move.totalScore;
      bestPair = pair;
    }
  }

  // Fallback: pick two random different consonants
  if (!bestPair) {
    const available = [];
    for (const ch of cfg.consonants) {
      if ((g.bag[ch] || 0) > 0) available.push(ch);
    }
    bestPair = available.slice(0, toChoose);
  }

  return bestPair;
}

// ─── AI Turn Execution ───────────────────────────────────────────────────────
// Returns an object describing what the AI did, for logging/debugging.
async function executeAITurn(g, gameId, gaddag, dawg, WordHistory, Player) {
  const aiToken = AI_TOKEN;
  const player = g.players[aiToken];
  if (!player) return { error: 'AI player not found' };

  // ─── Draw Phase ────────────────────────────────────────────────────────────
  if (g.phase === 'draw' && game.getCurrentPlayer(g) === aiToken && !g.drawDone) {
    if (g.variant === 'chosenword') {
      // Fetch AI word history
      let wordHistory = null;
      if (WordHistory && Player) {
        try {
          const aiDoc = await Player.findOne({ playerToken: AI_TOKEN });
          if (aiDoc) {
            const docs = await WordHistory.find({ playerId: aiDoc._id, lang: g.lang }).select('word -_id');
            wordHistory = docs.map(d => d.word);
          }
        } catch (err) {
          console.error('AI word history fetch error:', err.message);
        }
      }

      const chosen = chooseBestConsonants(g, aiToken, gaddag, dawg, wordHistory);
      const result = game.performChooseConsonants(g, aiToken, chosen);
      if (result.error) {
        // Fallback: try empty (rack full skip)
        if (result.error.code === 'WRONG_CONSONANT_COUNT') {
          game.performChooseConsonants(g, aiToken, []);
        } else {
          return { error: 'AI choose failed: ' + result.error.code };
        }
      }
    } else {
      // BestWord: random draw
      const result = game.performDraw(g, aiToken);
      if (result.error) return { error: 'AI draw failed: ' + result.error.code };
    }
  }

  // ─── Action Phase ──────────────────────────────────────────────────────────
  if (g.phase === 'action' && game.getCurrentPlayer(g) === aiToken) {
    // Fetch word history for ChosenWord
    let wordHistory = null;
    if (g.variant === 'chosenword' && WordHistory && Player) {
      try {
        const aiDoc = await Player.findOne({ playerToken: AI_TOKEN });
        if (aiDoc) {
          const docs = await WordHistory.find({ playerId: aiDoc._id, lang: g.lang }).select('word -_id');
          wordHistory = docs.map(d => d.word);
        }
      } catch (err) {
        console.error('AI word history fetch error:', err.message);
      }
    }

    // Generate moves
    const result = generateMoves(g.board, player.rack, g.bag, gaddag, dawg, g.lang, g.bridgeScoring, wordHistory);

    const threshold = getNoWordsThreshold(g, aiToken);
    const bestMove = result.moves.length > 0 ? result.moves[0] : null;
    const opponent = game.getOpponent(g, aiToken);
    const opponentPassed = opponent ? g.players[opponent].passed : false;

    if (bestMove && bestMove.totalScore >= threshold) {
      // Play the best move
      const placeResult = game.performPlaceWord(
        g, aiToken,
        bestMove.startRow, bestMove.startCol,
        bestMove.direction, bestMove.word,
        dawg
      );
      if (placeResult.error) {
        // Shouldn't happen — generator validated it — but handle gracefully
        console.error('AI play error:', placeResult.error.code, bestMove.word);
        // Try second best, etc.
        for (let i = 1; i < Math.min(10, result.moves.length); i++) {
          const alt = result.moves[i];
          const altResult = game.performPlaceWord(g, aiToken, alt.startRow, alt.startCol, alt.direction, alt.word, dawg);
          if (!altResult.error) {
            return { action: 'PLACE', word: alt.word, score: alt.totalScore };
          }
        }
        // All failed — fall through to NO WORDS / PASS
      } else {
        return { action: 'PLACE', word: bestMove.word, score: bestMove.totalScore };
      }
    }

    // Below threshold or no moves — try NO WORDS or PASS
    if (!opponentPassed && g.drewCount > 0) {
      // NO WORDS is legal
      // But if we have a move (just below threshold), consider playing it
      // in late game or when opponent is about to pass
      if (bestMove && bestMove.totalScore > 0) {
        const bagTotal = Object.values(g.bag).reduce((a, b) => a + b, 0);
        if (bagTotal < 30) {
          // Late game: play it anyway
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

    // No valid moves at all — must pass
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
  executeAITurn,
  chooseBestConsonants,
  getNoWordsThreshold
};
