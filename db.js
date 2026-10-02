// Database: one file (cope.db) holds everything. Created automatically on first run.
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'cope.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY, name TEXT, country TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, league_id INTEGER, name TEXT, squad_synced INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY, team_id INTEGER, name TEXT,
  position TEXT,              -- 'GK' or 'OUT'
  avg REAL,                   -- shots a game (outfield) or saves a game (keeper)
  apps INTEGER DEFAULT 0,     -- league appearances this season
  form TEXT DEFAULT '[]');    -- last 10 match counts, newest last
CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY, league_id INTEGER, home_id INTEGER, away_id INTEGER,
  kickoff INTEGER,            -- unix ms
  status TEXT DEFAULT 'NS',   -- NS not started, LIVE, FT finished, OFF postponed/abandoned
  minute INTEGER DEFAULT 0, home_goals INTEGER DEFAULT 0, away_goals INTEGER DEFAULT 0,
  ended_at INTEGER, settled INTEGER DEFAULT 0, venue TEXT);
CREATE TABLE IF NOT EXISTS player_stats (
  fixture_id INTEGER, player_id INTEGER,
  minutes INTEGER DEFAULT 0, shots INTEGER DEFAULT 0, saves INTEGER DEFAULT 0,
  PRIMARY KEY (fixture_id, player_id));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fixture_id INTEGER, minute INTEGER,
  text TEXT, player_id INTEGER, kind TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE COLLATE NOCASE,
  pass_hash TEXT, salt TEXT, points INTEGER,
  streak INTEGER DEFAULT 0, best_streak INTEGER DEFAULT 0,
  daily_limit INTEGER DEFAULT 500, break_until INTEGER DEFAULT 0,
  refill_at INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, stake INTEGER, odds REAL,
  potential INTEGER, status TEXT DEFAULT 'open',  -- open, won, lost, void, cashed
  payout INTEGER DEFAULT 0, created INTEGER, settled_at INTEGER);
CREATE TABLE IF NOT EXISTS legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER, fixture_id INTEGER, player_id INTEGER,
  stat TEXT, line REAL, side TEXT, odds REAL,
  status TEXT DEFAULT 'open',  -- open, won, lost, void
  result INTEGER);
CREATE INDEX IF NOT EXISTS i_legs_fx ON legs(fixture_id);
CREATE INDEX IF NOT EXISTS i_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS i_ev_fx ON events(fixture_id);
`);

module.exports = db;
