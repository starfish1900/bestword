const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { DAWG } = require('./dawg');
const { GADDAG } = require('./gaddag');
const { generateMoves } = require('./movegen');
const game = require('./game');
const { router: authRouter } = require('./auth');
const { verifyMailConfig } = require('./email');
const Player = require('./models/Player');
const WordHistory = require('./models/WordHistory');
const GameRecord = require('./models/GameRecord');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

// ─── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use('/auth', authRouter);
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB Connection ────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch(err => console.error('MongoDB connection error:', err.message));
} else {
  console.warn('MONGODB_URI not set — running without database (auth disabled)');
}

// ─── Load Dictionaries & Build DAWGs ────────────────────────────────────────
const dawgs = {};

console.log('Loading English dictionary...');
const dictEn = fs.readFileSync(path.join(__dirname, 'dictionary.txt'), 'utf-8');
const wordsEn = dictEn.split(/\r?\n/).map(w => w.trim().toUpperCase()).filter(w => w.length > 0);
console.log(`English dictionary: ${wordsEn.length} words`);
console.log('Building English DAWG...');
dawgs.en = DAWG.build(wordsEn);
console.log('English DAWG built');

console.log('Loading French dictionary...');
const dictFr = fs.readFileSync(path.join(__dirname, 'dictionary_fr.txt'), 'utf-8');
const wordsFr = dictFr.split(/\r?\n/).map(w => w.trim().toUpperCase()).filter(w => w.length > 0);
console.log(`French dictionary: ${wordsFr.length} words`);
console.log('Building French DAWG...');
dawgs.fr = DAWG.build(wordsFr);
console.log('French DAWG built');

console.log('Loading Spanish dictionary...');
const dictEs = fs.readFileSync(path.join(__dirname, 'dictionary_es.txt'), 'utf-8');
const wordsEs = dictEs.split(/\r?\n/).map(w => w.trim().toUpperCase()).filter(w => w.length > 0);
console.log(`Spanish dictionary: ${wordsEs.length} words`);
console.log('Building Spanish DAWG...');
dawgs.es = DAWG.build(wordsEs);
console.log('Spanish DAWG built');

function getDawg(lang) { return dawgs[lang] || dawgs.en; }

// ─── Build GADDAGs for move generation ───────────────────────────────────────
const gaddags = {};

console.log('Building English GADDAG...');
gaddags.en = GADDAG.build(wordsEn);

console.log('Building French GADDAG...');
gaddags.fr = GADDAG.build(wordsFr);

console.log('Building Spanish GADDAG...');
gaddags.es = GADDAG.build(wordsEs);

function getGaddag(lang) { return gaddags[lang] || gaddags.en; }

// ─── State ─────────────────────────────────────────────────────────────────────
const games = new Map();          // gameId -> game state
const lobby = new Map();          // requestId -> { playerToken, playerName, requestId, createdAt }
const playerSockets = new Map();  // playerToken -> socket
const socketPlayers = new Map();  // socket.id -> playerToken
const playerGames = new Map();    // playerToken -> gameId (active game)
const playerNames = new Map();    // playerToken -> display name

const DISCONNECT_TIMEOUT = 25000;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function emitToPlayer(playerToken, event, data) {
  const sock = playerSockets.get(playerToken);
  if (sock && sock.connected) {
    sock.emit(event, data);
  }
}

function broadcastLobby() {
  const list = [];
  for (const [reqId, req] of lobby) {
    list.push({ requestId: reqId, playerName: req.playerName, createdAt: req.createdAt, timeControl: req.timeControl, lang: req.lang, bridgeScoring: req.bridgeScoring, variant: req.variant });
  }
  io.emit('lobbyUpdate', list);
}

function sendGameState(gameObj) {
  for (const token of gameObj.playerOrder) {
    emitToPlayer(token, 'gameState', game.getGameState(gameObj, token));
  }
}

function cleanupGame(gameId) {
  const g = games.get(gameId);
  if (!g) return;
  for (const token of g.playerOrder) {
    const p = g.players[token];
    if (p && p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
    if (playerGames.get(token) === gameId) {
      playerGames.delete(token);
    }
  }
  games.delete(gameId);
}

// ─── Save game record to MongoDB ─────────────────────────────────────────────
async function saveGameRecord(g, gameResult) {
  if (!MONGODB_URI) return;
  try {
    // Look up player ObjectIds
    const playerDocs = {};
    for (const token of g.playerOrder) {
      const doc = await Player.findOne({ playerToken: token });
      if (doc) playerDocs[token] = doc;
    }

    // Build replay-compatible move list
    let moveNumber = 0;
    const moves = g.moveHistory.map(m => {
      moveNumber++;
      const playerIdx = g.playerOrder.indexOf(m.player);
      const entry = {
        moveNumber,
        playerIndex: playerIdx,
        action: m.action,
        timestamp: new Date()
      };
      if (m.action === 'DRAW') {
        entry.drawn = m.drawn || [];
      } else if (m.action === 'CHOOSE') {
        entry.chosen = m.chosen || [];
      } else if (m.action === 'PLACE') {
        entry.startRow = m.startRow;
        entry.startCol = m.startCol;
        entry.direction = m.direction;
        entry.word = m.word;
        entry.newTiles = m.newTiles;
        entry.secondaryWords = m.secondaryWords;
        entry.score = m.score;
      }
      // Add time remaining for the player who acted
      const p = g.players[m.player];
      if (p) entry.timeRemainingAfter = p.timeRemaining;
      return entry;
    });

    // Determine winner ObjectId
    let winnerDoc = null;
    let winnerIndex = null;
    if (gameResult.winner) {
      winnerDoc = playerDocs[gameResult.winner];
      winnerIndex = g.playerOrder.indexOf(gameResult.winner);
    }

    const record = new GameRecord({
      players: g.playerOrder.map((token, idx) => ({
        playerId: playerDocs[token] ? playerDocs[token]._id : null,
        username: g.players[token].name,
        playerToken: token,
        finalScore: g.players[token].score
      })),
      variant: g.variant || 'bestword',
      lang: g.lang,
      timeControl: g.timeControl,
      bridgeScoring: g.bridgeScoring,
      result: {
        winner: winnerDoc ? winnerDoc._id : null,
        winnerIndex,
        reason: gameResult.reason
      },
      initWords: g.initResult,
      moves,
      startedAt: new Date(g.createdAt),
      endedAt: new Date()
    });

    const savedRecord = await record.save();

    // Update player stats
    for (const token of g.playerOrder) {
      const doc = playerDocs[token];
      if (!doc) continue;
      doc.gamesPlayed++;
      if (gameResult.reason === 'draw') {
        doc.draws++;
      } else if (gameResult.winner === token) {
        doc.wins++;
      } else {
        doc.losses++;
      }
      // ChosenWord game counter
      if (g.variant === 'chosenword') {
        const langKey = g.lang;
        doc.chosenWordGamesPlayed[langKey] = (doc.chosenWordGamesPlayed[langKey] || 0) + 1;
        // 365-game cycle clear
        if (doc.chosenWordGamesPlayed[langKey] % 365 === 0) {
          await WordHistory.deleteMany({ playerId: doc._id, lang: langKey });
          console.log(`Cleared word history for ${doc.username} (${langKey}) at game ${doc.chosenWordGamesPlayed[langKey]}`);
        }
      }
      await doc.save();
    }

    // ChosenWord: save principal words to each player's word history
    if (g.variant === 'chosenword') {
      const wordEntries = [];
      for (const m of g.moveHistory) {
        if (m.action === 'PLACE' && m.word) {
          const doc = playerDocs[m.player];
          if (doc) {
            wordEntries.push({
              playerId: doc._id,
              lang: g.lang,
              word: m.word,
              gameId: savedRecord._id,
              playedAt: new Date()
            });
          }
        }
      }
      if (wordEntries.length > 0) {
        await WordHistory.insertMany(wordEntries);
      }
    }

    console.log(`Game record saved: ${savedRecord._id} (${g.variant}, ${g.lang})`);
  } catch (err) {
    console.error('Error saving game record:', err.message);
  }
}

function finishGameByDisconnect(gameId, disconnectedToken) {
  const g = games.get(gameId);
  if (!g || g.phase === 'finished') return;
  g.phase = 'finished';
  g.turnStartedAt = null;
  const opponent = game.getOpponent(g, disconnectedToken);
  // Opponent wins by disconnect
  g.moveHistory.push({ player: disconnectedToken, action: 'DISCONNECT_LOSS' });

  for (const token of g.playerOrder) {
    const state = game.getGameState(g, token);
    state.result = {
      winner: opponent,
      reason: 'disconnect',
      isWinner: token === opponent
    };
    emitToPlayer(token, 'gameOver', state);
  }

  // Cleanup after a short delay
  const disconnectResult = { winner: opponent, loser: disconnectedToken, reason: 'disconnect' };
  saveGameRecord(g, disconnectResult).catch(err => console.error('Failed to save game record:', err.message));
  setTimeout(() => cleanupGame(gameId), 5000);
}

function finishGameByTimeout(gameId, timedOutToken) {
  const g = games.get(gameId);
  if (!g || g.phase === 'finished') return;
  g.phase = 'finished';
  g.turnStartedAt = null;
  g.players[timedOutToken].timeRemaining = 0;
  const opponent = game.getOpponent(g, timedOutToken);
  g.moveHistory.push({ player: timedOutToken, action: 'TIMEOUT_LOSS' });

  for (const token of g.playerOrder) {
    const state = game.getGameState(g, token);
    state.result = {
      winner: opponent,
      reason: 'timeout',
      isWinner: token === opponent
    };
    emitToPlayer(token, 'gameOver', state);
  }

  const timeoutResult = { winner: opponent, loser: timedOutToken, reason: 'timeout' };
  saveGameRecord(g, timeoutResult).catch(err => console.error('Failed to save game record:', err.message));
  setTimeout(() => cleanupGame(gameId), 5000);
}

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let playerToken = null;

  socket.on('register', (data) => {
    playerToken = data.token;
    const name = (data.name || 'Anonymous').substring(0, 20);
    playerNames.set(playerToken, name);

    // Handle re-registration (old socket for same token)
    const oldSocket = playerSockets.get(playerToken);
    if (oldSocket && oldSocket.id !== socket.id) {
      socketPlayers.delete(oldSocket.id);
    }

    playerSockets.set(playerToken, socket);
    socketPlayers.set(socket.id, playerToken);

    // Check if player is in an active game (reconnection)
    const activeGameId = playerGames.get(playerToken);
    if (activeGameId) {
      if (games.has(activeGameId)) {
        const g = games.get(activeGameId);
        if (g.phase !== 'finished' && g.players[playerToken]) {
          // Cancel disconnect timer
          const p = g.players[playerToken];
          if (p.disconnectTimer) {
            clearTimeout(p.disconnectTimer);
            p.disconnectTimer = null;
          }
          p.connected = true;

          // Notify opponent
          const opp = game.getOpponent(g, playerToken);
          if (opp) emitToPlayer(opp, 'opponentReconnected', {});

          // Send current game state
          socket.emit('rejoinGame', game.getGameState(g, playerToken));
          sendGameState(g);
          return;
        } else {
          // Game is finished — clean up stale mapping
          playerGames.delete(playerToken);
        }
      } else {
        // Game no longer exists — clean up stale mapping
        playerGames.delete(playerToken);
      }
    }

    socket.emit('registered', { token: playerToken, name });
    broadcastLobby();
  });

  // ─── Lobby ───────────────────────────────────────────────────────────────
  socket.on('createRequest', (data) => {
    if (!playerToken) return;
    // Remove any existing request from this player
    for (const [reqId, req] of lobby) {
      if (req.playerToken === playerToken) lobby.delete(reqId);
    }
    // Check player not already in a game
    if (playerGames.has(playerToken)) {
      socket.emit('error', { message: 'You are already in a game' });
      return;
    }
    // Parse time control
    const validMinutes = [5, 15, 25, 35];
    const minutes = (data && validMinutes.includes(data.minutes)) ? data.minutes : 15;
    const timeControl = { minutes, increment: 30 };

    // Parse language
    const lang = (data && ['fr', 'es'].includes(data.lang)) ? data.lang : 'en';

    // Parse bridge scoring
    const bridgeScoring = !!(data && data.bridgeScoring);

    // Parse variant
    const variant = (data && data.variant === 'chosenword') ? 'chosenword' : 'bestword';

    const requestId = uuidv4();
    lobby.set(requestId, {
      playerToken,
      playerName: playerNames.get(playerToken) || 'Anonymous',
      requestId,
      createdAt: Date.now(),
      timeControl,
      lang,
      bridgeScoring,
      variant
    });
    broadcastLobby();
  });

  socket.on('cancelRequest', () => {
    if (!playerToken) return;
    for (const [reqId, req] of lobby) {
      if (req.playerToken === playerToken) lobby.delete(reqId);
    }
    broadcastLobby();
  });

  socket.on('joinRequest', (data) => {
    if (!playerToken) return;
    const req = lobby.get(data.requestId);
    if (!req) {
      socket.emit('error', { message: 'Game request no longer available' });
      return;
    }
    if (req.playerToken === playerToken) {
      socket.emit('error', { message: 'Cannot join your own request' });
      return;
    }
    if (playerGames.has(playerToken)) {
      socket.emit('error', { message: 'You are already in a game' });
      return;
    }

    // Remove request from lobby
    lobby.delete(data.requestId);
    // Remove any other requests by either player
    for (const [reqId, r] of lobby) {
      if (r.playerToken === req.playerToken || r.playerToken === playerToken) {
        lobby.delete(reqId);
      }
    }
    broadcastLobby();

    // Create game
    const gameId = uuidv4();
    try {
      const g = game.createGame(gameId, req.playerToken, req.playerName, getDawg(req.lang), req.timeControl, req.lang, req.bridgeScoring, req.variant);
      game.addPlayer(g, playerToken, playerNames.get(playerToken) || 'Anonymous');
      games.set(gameId, g);
      playerGames.set(req.playerToken, gameId);
      playerGames.set(playerToken, gameId);

      emitToPlayer(req.playerToken, 'gameStarted', {
        gameId,
        opponentName: playerNames.get(playerToken) || 'Anonymous',
        playerIndex: 0,
        timeControl: req.timeControl,
        lang: req.lang,
        bridgeScoring: req.bridgeScoring,
        variant: req.variant
      });
      socket.emit('gameStarted', {
        gameId,
        opponentName: playerNames.get(req.playerToken) || 'Anonymous',
        playerIndex: 1,
        timeControl: req.timeControl,
        lang: req.lang,
        bridgeScoring: req.bridgeScoring,
        variant: req.variant
      });

      sendGameState(g);
    } catch (err) {
      console.error('Error creating game:', err);
      socket.emit('error', { message: 'Error creating game: ' + err.message });
    }
  });

  // ─── Game Actions ────────────────────────────────────────────────────────

  // Helper: if an action returns timeout error, finish the game by timeout
  function handleActionResult(result, gameId, g) {
    if (result.error) {
      if (result.error.code === 'TIMEOUT') {
        finishGameByTimeout(gameId, game.getCurrentPlayer(g));
        return true;
      }
      socket.emit('actionError', result.error);
      return true; // handled (error)
    }
    return false; // no error, continue
  }

  function checkFinishedAndNotify(gameId, g) {
    if (g.phase === 'finished') {
      const gameResult = game.getGameResult(g);
      for (const token of g.playerOrder) {
        const state = game.getGameState(g, token);
        state.result = {
          winner: gameResult.winner,
          reason: gameResult.reason,
          isWinner: token === gameResult.winner,
          isDraw: gameResult.reason === 'draw'
        };
        emitToPlayer(token, 'gameOver', state);
      }
      // Save game record and word history asynchronously
      saveGameRecord(g, gameResult).catch(err => console.error('Failed to save game record:', err.message));
      setTimeout(() => cleanupGame(gameId), 5000);
      return true;
    }
    return false;
  }

  socket.on('draw', () => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;
    if (g.variant === 'chosenword') {
      socket.emit('actionError', { code: 'USE_CHOOSE_CONSONANTS' });
      return;
    }

    const result = game.performDraw(g, playerToken);
    if (handleActionResult(result, gameId, g)) return;

    socket.emit('drawResult', { drawn: result.drawn, rackCount: result.rackCount });
    sendGameState(g);
  });

  socket.on('chooseConsonants', (data) => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;
    if (g.variant !== 'chosenword') {
      socket.emit('actionError', { code: 'NOT_CHOSENWORD' });
      return;
    }

    const letters = (data && data.letters) ? data.letters.map(l => l.toUpperCase()) : [];
    const result = game.performChooseConsonants(g, playerToken, letters);
    if (handleActionResult(result, gameId, g)) return;

    socket.emit('chooseResult', { chosen: result.chosen, rackCount: result.rackCount });
    sendGameState(g);
  });

  socket.on('pass', () => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;

    const result = game.performPass(g, playerToken);
    if (handleActionResult(result, gameId, g)) return;
    if (!checkFinishedAndNotify(gameId, g)) sendGameState(g);
  });

  socket.on('noWords', () => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;

    const result = game.performNoWords(g, playerToken);
    if (handleActionResult(result, gameId, g)) return;
    sendGameState(g);
  });

  socket.on('placeWord', async (data) => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;

    const { startRow, startCol, direction, word } = data;

    // ChosenWord: check word history before validating move
    if (g.variant === 'chosenword' && MONGODB_URI) {
      try {
        const player = await Player.findOne({ playerToken });
        if (player) {
          const blocked = await WordHistory.findOne({
            playerId: player._id,
            lang: g.lang,
            word: word.toUpperCase()
          });
          if (blocked) {
            socket.emit('actionError', { code: 'WORD_IN_HISTORY', word: word.toUpperCase() });
            return;
          }
        }
      } catch (err) {
        console.error('Word history check error:', err.message);
      }
    }

    const result = game.performPlaceWord(g, playerToken, startRow, startCol, direction, word, getDawg(g.lang));
    if (handleActionResult(result, gameId, g)) return;

    // Notify both players
    for (const token of g.playerOrder) {
      emitToPlayer(token, 'wordPlaced', {
        principalWord: result.principalWord,
        secondaryWords: result.secondaryWords,
        score: result.score,
        newTiles: result.newTiles,
        playedBy: token === playerToken ? 'you' : 'opponent'
      });
    }

    if (!checkFinishedAndNotify(gameId, g)) sendGameState(g);
  });

  // ─── Move Generation (Ctrl+G hidden feature) ────────────────────────────
  socket.on('generateMoves', async () => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;
    if (game.getCurrentPlayer(g) !== playerToken) {
      socket.emit('actionError', { code: 'NOT_YOUR_TURN' });
      return;
    }
    if (g.phase !== 'action') {
      socket.emit('actionError', { code: 'NOT_ACTION_PHASE' });
      return;
    }

    const player = g.players[playerToken];
    const gaddag = getGaddag(g.lang);
    const dawg = getDawg(g.lang);

    // Get word history for ChosenWord
    let wordHistorySet = null;
    if (g.variant === 'chosenword' && MONGODB_URI) {
      try {
        const playerDoc = await Player.findOne({ playerToken });
        if (playerDoc) {
          const histDocs = await WordHistory.find({ playerId: playerDoc._id, lang: g.lang }).select('word -_id');
          wordHistorySet = histDocs.map(h => h.word);
        }
      } catch (err) {
        console.error('Word history fetch for movegen:', err.message);
      }
    }

    try {
      const result = generateMoves(
        g.board, player.rack, g.bag, gaddag, dawg,
        g.lang, g.bridgeScoring, wordHistorySet
      );
      socket.emit('movesGenerated', {
        moves: result.moves.slice(0, 200), // cap at top 200
        total: result.moves.length,
        elapsed: result.elapsed
      });
    } catch (err) {
      console.error('Move generation error:', err);
      socket.emit('actionError', { code: 'GENERATION_ERROR' });
    }
  });

  // ─── Chat ────────────────────────────────────────────────────────────────
  socket.on('chat', (data) => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g) return;

    const opponent = game.getOpponent(g, playerToken);
    if (opponent) {
      emitToPlayer(opponent, 'chat', {
        from: playerNames.get(playerToken) || 'Anonymous',
        message: (data.message || '').substring(0, 200)
      });
    }
  });

  // ─── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!playerToken) return;

    const currentSocket = playerSockets.get(playerToken);
    if (currentSocket && currentSocket.id !== socket.id) {
      // This is an old socket, a newer one exists. Just clean up references.
      socketPlayers.delete(socket.id);
      return;
    }

    socketPlayers.delete(socket.id);
    playerSockets.delete(playerToken);

    // Remove from lobby
    for (const [reqId, req] of lobby) {
      if (req.playerToken === playerToken) lobby.delete(reqId);
    }
    broadcastLobby();

    // Handle active game
    const gameId = playerGames.get(playerToken);
    if (gameId && games.has(gameId)) {
      const g = games.get(gameId);
      if (g.phase !== 'finished' && g.players[playerToken]) {
        g.players[playerToken].connected = false;

        const opp = game.getOpponent(g, playerToken);
        if (opp) emitToPlayer(opp, 'opponentDisconnected', { timeout: DISCONNECT_TIMEOUT });

        // Start disconnect timer
        g.players[playerToken].disconnectTimer = setTimeout(() => {
          finishGameByDisconnect(gameId, playerToken);
        }, DISCONNECT_TIMEOUT);
      }
    }
  });
});

// ─── Periodic clock timeout check (every 1 second) ────────────────────────
setInterval(() => {
  for (const [gameId, g] of games) {
    if (g.phase === 'finished' || g.phase === 'waiting') continue;
    const timedOut = game.checkTimeout(g);
    if (timedOut) {
      finishGameByTimeout(gameId, timedOut);
    }
  }
}, 1000);

// ─── Periodic cleanup of stale lobby requests (older than 5 min) ───────────
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [reqId, req] of lobby) {
    if (now - req.createdAt > 5 * 60 * 1000) {
      lobby.delete(reqId);
      changed = true;
    }
  }
  if (changed) broadcastLobby();
}, 30000);

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`BestWord server running on port ${PORT}`);
  await verifyMailConfig();
});
