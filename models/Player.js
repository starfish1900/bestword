const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const playerSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format']
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [15, 'Username must be at most 15 characters'],
    match: [/^[a-zA-Z0-9]+$/, 'Username must be alphanumeric'],
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  verified: {
    type: Boolean,
    default: false
  },
  verificationToken: {
    type: String,
    default: null
  },
  verificationTokenExpires: {
    type: Date,
    default: null
  },
  // Permanent player token used by Socket.io (replaces the old client-generated UUID)
  playerToken: {
    type: String,
    required: true,
    unique: true
  },
  // Rating
  rating: {
    type: Number,
    default: 1500
  },
  // Stats
  gamesPlayed: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  // ChosenWord stats (per language)
  chosenWordGamesPlayed: {
    en: { type: Number, default: 0 },
    fr: { type: Number, default: 0 },
    es: { type: Number, default: 0 }
  }
}, {
  timestamps: true // adds createdAt and updatedAt
});

// Hash password before saving
playerSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Compare password method
playerSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Indexes
playerSchema.index({ email: 1 });
playerSchema.index({ username: 1 });
playerSchema.index({ playerToken: 1 });
playerSchema.index({ verificationToken: 1 });

const Player = mongoose.model('Player', playerSchema);

module.exports = Player;
