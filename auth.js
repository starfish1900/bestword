const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Player = require('./models/Player');
const WordHistory = require('./models/WordHistory');
const GameRecord = require('./models/GameRecord');
const { sendVerificationEmail } = require('./email');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'bestword-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '30d'; // tokens last 30 days

// ─── Helper: generate JWT ──────────────────────────────────────────────────────
function generateJWT(player) {
  return jwt.sign(
    { id: player._id, playerToken: player.playerToken, username: player.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ─── Helper: generate verification token ────────────────────────────────────────
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── POST /auth/signup ─────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, username, password } = req.body;

    // Validate inputs
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username, and password are required' });
    }

    // Username validation
    if (username.length < 3 || username.length > 15) {
      return res.status(400).json({ error: 'Username must be between 3 and 15 characters' });
    }
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      return res.status(400).json({ error: 'Username must be alphanumeric' });
    }

    // Password validation
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check for existing email
    const existingEmail = await Player.findOne({ email: email.toLowerCase().trim() });
    if (existingEmail) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Check for existing username (case-insensitive)
    const existingUsername = await Player.findOne({
      username: { $regex: new RegExp(`^${username}$`, 'i') }
    });
    if (existingUsername) {
      return res.status(409).json({ error: 'This username is already taken' });
    }

    // Create verification token
    const verificationToken = generateVerificationToken();
    const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create player
    const player = new Player({
      email: email.toLowerCase().trim(),
      username: username.trim(),
      password,
      playerToken: uuidv4(),
      verificationToken,
      verificationTokenExpires
    });

    await player.save();

    // Send verification email
    try {
      await sendVerificationEmail(player.email, player.username, verificationToken);
    } catch (emailErr) {
      console.error('Failed to send verification email:', emailErr.message);
      // Account is created but email failed — player can request a resend
    }

    res.status(201).json({
      message: 'Account created. Please check your email to verify your account.',
      username: player.username
    });

  } catch (err) {
    console.error('Signup error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email or username already exists' });
    }
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// ─── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body; // login can be email or username

    if (!login || !password) {
      return res.status(400).json({ error: 'Email/username and password are required' });
    }

    // Find player by email or username
    const player = await Player.findOne({
      $or: [
        { email: login.toLowerCase().trim() },
        { username: { $regex: new RegExp(`^${login.trim()}$`, 'i') } }
      ]
    });

    if (!player) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await player.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if verified
    if (!player.verified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in',
        needsVerification: true,
        email: player.email
      });
    }

    // Generate JWT
    const token = generateJWT(player);

    res.json({
      token,
      player: {
        username: player.username,
        playerToken: player.playerToken,
        rating: player.rating,
        gamesPlayed: player.gamesPlayed,
        wins: player.wins,
        losses: player.losses,
        draws: player.draws
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ─── GET /verify ───────────────────────────────────────────────────────────────
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).send(verificationPage('Invalid verification link.', false));
    }

    const player = await Player.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: new Date() }
    });

    if (!player) {
      return res.status(400).send(verificationPage('Verification link is invalid or has expired.', false));
    }

    if (player.verified) {
      return res.send(verificationPage('Your email is already verified. You can log in.', true));
    }

    player.verified = true;
    player.verificationToken = null;
    player.verificationTokenExpires = null;
    await player.save();

    res.send(verificationPage(`Welcome, ${player.username}! Your email has been verified. You can now log in and play.`, true));

  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).send(verificationPage('Server error during verification.', false));
  }
});

// ─── POST /auth/resend-verification ────────────────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const player = await Player.findOne({ email: email.toLowerCase().trim() });

    if (!player) {
      // Don't reveal whether the email exists
      return res.json({ message: 'If an account with that email exists, a verification email has been sent.' });
    }

    if (player.verified) {
      return res.json({ message: 'This email is already verified. You can log in.' });
    }

    // Generate new token
    player.verificationToken = generateVerificationToken();
    player.verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await player.save();

    try {
      await sendVerificationEmail(player.email, player.username, player.verificationToken);
    } catch (emailErr) {
      console.error('Failed to resend verification email:', emailErr.message);
    }

    res.json({ message: 'If an account with that email exists, a verification email has been sent.' });

  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Middleware: authenticate JWT ───────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.player = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── GET /auth/me — get current player info ─────────────────────────────────────
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const player = await Player.findById(req.player.id).select('-password -verificationToken -verificationTokenExpires');
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json({
      username: player.username,
      playerToken: player.playerToken,
      email: player.email,
      rating: player.rating,
      gamesPlayed: player.gamesPlayed,
      wins: player.wins,
      losses: player.losses,
      draws: player.draws
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /auth/word-history — get player's ChosenWord word history ────────────
router.get('/word-history', authenticateToken, async (req, res) => {
  try {
    const player = await Player.findById(req.player.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const lang = ['en', 'fr', 'es'].includes(req.query.lang) ? req.query.lang : 'en';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const search = req.query.search ? req.query.search.toUpperCase().trim() : null;

    const filter = { playerId: player._id, lang };
    if (search) {
      filter.word = { $regex: search };
    }

    const total = await WordHistory.countDocuments(filter);
    const words = await WordHistory.find(filter)
      .sort({ playedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('word playedAt -_id');

    res.json({
      lang,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      words: words.map(w => ({ word: w.word, playedAt: w.playedAt })),
      chosenWordGamesPlayed: player.chosenWordGamesPlayed[lang] || 0,
      gamesUntilClear: 365 - ((player.chosenWordGamesPlayed[lang] || 0) % 365)
    });
  } catch (err) {
    console.error('Word history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /auth/games/search — search completed games ─────────────────────────
router.get('/games/search', authenticateToken, async (req, res) => {
  try {
    const filter = {};

    // Player username (case-insensitive partial match)
    if (req.query.player && req.query.player.trim()) {
      filter['players.username'] = { $regex: req.query.player.trim(), $options: 'i' };
    }

    // AI games — use $elemMatch to avoid conflicts with player filter
    if (req.query.ai === 'yes') {
      if (!filter.$and) filter.$and = [];
      filter.$and.push({ 'players.username': 'BestWord AI' });
    }
    if (req.query.ai === 'no') {
      if (!filter.$and) filter.$and = [];
      filter.$and.push({ 'players.username': { $ne: 'BestWord AI' } });
    }

    // Language
    if (req.query.lang && ['en', 'fr', 'es'].includes(req.query.lang)) {
      filter.lang = req.query.lang;
    }

    // Variant
    if (req.query.variant && ['bestword', 'chosenword'].includes(req.query.variant)) {
      filter.variant = req.query.variant;
    }

    // Bridge scoring
    if (req.query.bridge === 'yes') filter.bridgeScoring = true;
    if (req.query.bridge === 'no') filter.bridgeScoring = false;

    // Min score threshold (at least one player scored >= N)
    if (req.query.minScore) {
      const minScore = parseInt(req.query.minScore);
      if (!isNaN(minScore) && minScore > 0) {
        filter['players.finalScore'] = { $gte: minScore };
      }
    }

    // Date range
    if (req.query.dateFrom || req.query.dateTo) {
      filter.startedAt = {};
      if (req.query.dateFrom) {
        const from = new Date(req.query.dateFrom);
        if (!isNaN(from.getTime())) filter.startedAt.$gte = from;
      }
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        if (!isNaN(to.getTime())) {
          to.setHours(23, 59, 59, 999);
          filter.startedAt.$lte = to;
        }
      }
      if (Object.keys(filter.startedAt).length === 0) delete filter.startedAt;
    }

    // Result reason
    if (req.query.result && ['score', 'draw', 'timeout', 'disconnect'].includes(req.query.result)) {
      filter['result.reason'] = req.query.result;
    }

    // Pagination
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;

    const total = await GameRecord.countDocuments(filter);
    const games = await GameRecord.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('players variant lang bridgeScoring result timeControl startedAt endedAt')
      .lean();

    const results = games.map(g => ({
      id: g._id,
      players: g.players.map(p => ({ username: p.username, finalScore: p.finalScore })),
      variant: g.variant,
      lang: g.lang,
      bridgeScoring: g.bridgeScoring,
      result: g.result,
      timeControl: g.timeControl,
      startedAt: g.startedAt,
      endedAt: g.endedAt
    }));

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      games: results
    });
  } catch (err) {
    console.error('Game search error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /auth/games/:id — get full game record for replay ──────────────────
router.get('/games/:id', authenticateToken, async (req, res) => {
  try {
    const gameRecord = await GameRecord.findById(req.params.id).lean();
    if (!gameRecord) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json({
      id: gameRecord._id,
      players: gameRecord.players.map(p => ({ username: p.username, finalScore: p.finalScore })),
      variant: gameRecord.variant,
      lang: gameRecord.lang,
      bridgeScoring: gameRecord.bridgeScoring,
      result: gameRecord.result,
      timeControl: gameRecord.timeControl,
      initWords: gameRecord.initWords,
      moves: gameRecord.moves,
      startedAt: gameRecord.startedAt,
      endedAt: gameRecord.endedAt
    });
  } catch (err) {
    console.error('Game fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Verification result page HTML ──────────────────────────────────────────────
function verificationPage(message, success) {
  const color = success ? '#4caf7d' : '#e05555';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BestWord — Email Verification</title>
  <style>
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0f1117;
      color: #e8e6e3;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .box {
      background: #181b24;
      border: 2px solid ${color};
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      max-width: 400px;
    }
    h1 { color: #e8a946; font-size: 28px; margin-bottom: 16px; }
    p { color: #9ea3b0; font-size: 16px; line-height: 1.6; }
    .msg { color: ${color}; font-weight: 600; }
    a {
      display: inline-block;
      margin-top: 20px;
      background: #e8a946;
      color: #0f1117;
      padding: 12px 28px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>BestWord</h1>
    <p class="msg">${message}</p>
    <a href="/">Go to BestWord</a>
  </div>
</body>
</html>`;
}

module.exports = { router, authenticateToken, JWT_SECRET };
