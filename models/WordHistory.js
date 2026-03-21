const mongoose = require('mongoose');

const wordHistorySchema = new mongoose.Schema({
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player',
    required: true
  },
  lang: {
    type: String,
    enum: ['en', 'fr', 'es'],
    required: true
  },
  word: {
    type: String,
    required: true
  },
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  playedAt: {
    type: Date,
    default: Date.now
  }
});

// Fast lookup: "has this player used this word in this language?"
wordHistorySchema.index({ playerId: 1, lang: 1, word: 1 });
// For listing a player's history
wordHistorySchema.index({ playerId: 1, lang: 1, playedAt: -1 });

const WordHistory = mongoose.model('WordHistory', wordHistorySchema);

module.exports = WordHistory;
