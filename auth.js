// Accounts: username + password. Passwords are hashed with scrypt (built into Node), never stored plain.
const crypto = require('crypto');
const db = require('./db');

const START_POINTS = parseInt(process.env.START_POINTS || '10000', 10);

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(token, userId, Date.now());
  return token;
}

function signup(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) throw new Error('Username must be 3 to 20 letters, numbers, dots or underscores');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new Error('That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare('INSERT INTO users (username, pass_hash, salt, points, created) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash(password, salt), salt, START_POINTS, Date.now());
  return newSession(info.lastInsertRowid);
}

function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u) throw new Error('Wrong username or password');
  const a = Buffer.from(hash(String(password || ''), u.salt), 'hex');
  const b = Buffer.from(u.pass_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Wrong username or password');
  return newSession(u.id);
}

function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  return s ? db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) : null;
}

// Express middleware: reads "Authorization: Bearer <token>"
function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  next();
}

module.exports = { signup, login, userFromToken, requireUser };
