const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { DAWG } = require('./dawg');
const game = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Load Dictionary & Build DAWG ──────────────────────────────────────────────
console.log('Loading dictionary...');
const dictRaw = fs.readFileSync(path.join(__dirname, 'dictionary.txt'), 'utf-8');
const words = dictRaw.split(/\r?\n/).map(w => w.trim().toUpperCase()).filter(w => w.length > 0);
console.log(`Dictionary loaded: ${words.length} words`);
console.log('Building DAWG...');
const dawg = DAWG.build(words);
console.log('DAWG built successfully');

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
    list.push({ requestId: reqId, playerName: req.playerName, createdAt: req.createdAt, timeControl: req.timeControl });
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
  setTimeout(() => cleanupGame(gameId), 5000);
}

function finishGameByTimeout(gameId, timedOutToken) {
  const g = games.get(gameId);
  if (!g || g.phase === 'finished') return;
  g.phase = 'finished';
  g.turnStartedAt = null;
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
    if (activeGameId && games.has(activeGameId)) {
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
    const validMinutes = [5, 15, 25];
    const minutes = (data && validMinutes.includes(data.minutes)) ? data.minutes : 15;
    const timeControl = { minutes, increment: 30 };

    const requestId = uuidv4();
    lobby.set(requestId, {
      playerToken,
      playerName: playerNames.get(playerToken) || 'Anonymous',
      requestId,
      createdAt: Date.now(),
      timeControl
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
      const g = game.createGame(gameId, req.playerToken, req.playerName, dawg, req.timeControl);
      game.addPlayer(g, playerToken, playerNames.get(playerToken) || 'Anonymous');
      games.set(gameId, g);
      playerGames.set(req.playerToken, gameId);
      playerGames.set(playerToken, gameId);

      emitToPlayer(req.playerToken, 'gameStarted', {
        gameId,
        opponentName: playerNames.get(playerToken) || 'Anonymous',
        playerIndex: 0,
        timeControl: req.timeControl
      });
      socket.emit('gameStarted', {
        gameId,
        opponentName: playerNames.get(req.playerToken) || 'Anonymous',
        playerIndex: 1,
        timeControl: req.timeControl
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
    if (result.error === 'timeout') {
      finishGameByTimeout(gameId, game.getCurrentPlayer(g));
      return true; // handled
    }
    if (result.error) {
      socket.emit('actionError', { message: result.error });
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

    const result = game.performDraw(g, playerToken);
    if (handleActionResult(result, gameId, g)) return;

    socket.emit('drawResult', { drawn: result.drawn, rackCount: result.rackCount });
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

  socket.on('placeWord', (data) => {
    if (!playerToken) return;
    const gameId = playerGames.get(playerToken);
    if (!gameId) return;
    const g = games.get(gameId);
    if (!g || g.phase === 'finished') return;

    const { startRow, startCol, direction, word } = data;
    const result = game.performPlaceWord(g, playerToken, startRow, startCol, direction, word, dawg);
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
server.listen(PORT, () => {
  console.log(`BestWord server running on port ${PORT}`);
});
