const mongoose = require('mongoose');

const moveSchema = new mongoose.Schema({
  moveNumber: Number,
  playerIndex: { type: Number, enum: [0, 1] },
  action: { type: String, enum: ['DRAW', 'CHOOSE', 'PLACE', 'PASS', 'NO_WORDS', 'DISCONNECT_LOSS', 'TIMEOUT_LOSS'] },

  // For DRAW (BestWord random)
  drawn: [String],

  // For CHOOSE (ChosenWord deliberate)
  chosen: [String],

  // For PLACE
  startRow: Number,
  startCol: Number,
  direction: { type: String, enum: ['H', 'V'] },
  word: String,
  newTiles: [{
    row: Number,
    col: Number,
    letter: String
  }],
  secondaryWords: [String],
  score: Number,

  // Timing
  timeRemainingAfter: Number,
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const gameRecordSchema = new mongoose.Schema({
  players: [{
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
    username: String,
    playerToken: String,
    finalScore: Number
  }],
  variant: {
    type: String,
    enum: ['bestword', 'chosenword'],
    required: true
  },
  lang: {
    type: String,
    enum: ['en', 'fr', 'es'],
    required: true
  },
  timeControl: {
    minutes: Number,
    increment: Number
  },
  bridgeScoring: { type: Boolean, default: false },
  result: {
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', default: null },
    winnerIndex: { type: Number, default: null }, // 0 or 1
    reason: { type: String, enum: ['score', 'draw', 'timeout', 'disconnect'] }
  },

  // Initial state for replay
  initWords: {
    word1: String,
    word1Row: Number,
    word1StartCol: Number,
    word2: String,
    word2Col: Number,
    word2StartRow: Number
  },

  // Complete ordered move history
  moves: [moveSchema],

  startedAt: { type: Date, default: Date.now },
  endedAt: Date
});

// Indexes for common queries
gameRecordSchema.index({ 'players.playerId': 1, startedAt: -1 });
gameRecordSchema.index({ variant: 1, lang: 1 });
gameRecordSchema.index({ startedAt: -1 });

const GameRecord = mongoose.model('Game', gameRecordSchema);

module.exports = GameRecord;
