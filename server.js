// cope server: website + API + live push. Start with "npm start" (live stats) or "npm run test-mode".
require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const bus = require('./bus');
const auth = require('./auth');
const settle = require('./settle');
const { price, mainLine, allLines } = require('./pricing');

const TEST = process.argv.includes('--test');
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_LEGS = 5;
const MIN_STAKE = 10;
const LAST_BET_MINUTE = 85;   // markets close at 85'
const ODDS_TOLERANCE = 0.05;  // if the price moved more than this, ask the player to accept the new one

const app = express();
app.use(express.json());
// Only these three files are public. Everything else in the folder stays private.
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/favicon.svg': 'favicon.svg', '/favicon.png': 'favicon.png', '/favicon.ico': 'favicon.png' };
app.get(Object.keys(PAGES), (req, res) => res.sendFile(path.join(__dirname, PAGES[req.path])));

// ---------- helpers ----------
const statOf = p => (p.position === 'GK' ? 'saves' : 'shots');

function fixtureRow(f) {
  const l = db.prepare('SELECT * FROM leagues WHERE id = ?').get(f.league_id) || {};
  const h = db.prepare('SELECT name FROM teams WHERE id = ?').get(f.home_id) || {};
  const a = db.prepare('SELECT name FROM teams WHERE id = ?').get(f.away_id) || {};
  return { id: f.id, league: l.name, leagueId: f.league_id, color: l.color, home: h.name, away: a.name,
    homeId: f.home_id, awayId: f.away_id, kickoff: f.kickoff, status: f.status, minute: f.minute,
    homeGoals: f.home_goals, awayGoals: f.away_goals, venue: f.venue };
}

// Live price of one player in one match
function market(p, f, line) {
  const st = db.prepare('SELECT * FROM player_stats WHERE fixture_id = ? AND player_id = ?').get(f.id, p.id);
  const soFar = st ? st[statOf(p)] : 0;
  const minute = f.status === 'LIVE' ? f.minute : 0;
  const l = line != null ? line : mainLine(p.avg);
  const pr = price(l, p.avg, soFar, minute);
  const bettable = (f.status === 'NS' || (f.status === 'LIVE' && f.minute < LAST_BET_MINUTE)) && pr.open && p.avg > 0;
  return { playerId: p.id, name: p.name, team: (db.prepare('SELECT name FROM teams WHERE id = ?').get(p.team_id) || {}).name,
    position: p.position, stat: statOf(p), avg: p.avg, apps: p.apps, line: l, soFar, more: pr.more, less: pr.less,
    chanceMore: Math.round(pr.pMore * 100), bettable, playing: !!st };
}

function pricedPlayers(f) {
  return db.prepare('SELECT * FROM players WHERE team_id IN (?, ?) AND avg > 0 AND apps >= 5 ORDER BY avg DESC').all(f.home_id, f.away_id);
}

function openFixtures() {
  return db.prepare("SELECT * FROM fixtures WHERE status IN ('NS','LIVE') ORDER BY status = 'LIVE' DESC, kickoff ASC").all();
}

function stakedToday(userId) {
  return db.prepare('SELECT COALESCE(SUM(stake),0) s FROM bets WHERE user_id = ? AND created > ?').get(userId, Date.now() - 86400000).s;
}

function publicUser(u) {
  return { id: u.id, username: u.username, points: u.points, streak: u.streak, bestStreak: u.best_streak,
    dailyLimit: u.daily_limit, stakedToday: stakedToday(u.id), breakUntil: u.break_until,
    canRefill: u.points < 100 && Date.now() - u.refill_at > 86400000, mode: TEST ? 'test' : 'live' };
}

function betView(b) {
  const legs = db.prepare('SELECT * FROM legs WHERE bet_id = ?').all(b.id).map(l => {
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(l.player_id);
    const f = db.prepare('SELECT * FROM fixtures WHERE id = ?').get(l.fixture_id);
    const st = db.prepare('SELECT * FROM player_stats WHERE fixture_id = ? AND player_id = ?').get(l.fixture_id, l.player_id);
    const soFar = st ? st[l.stat] : 0;
    const minute = f.status === 'LIVE' ? f.minute : f.status === 'FT' ? 90 : 0;
    const pMore = price(l.line, p.avg, soFar, minute).pMore;
    let chance = l.side === 'more' ? pMore : 1 - pMore;
    if (l.status === 'won') chance = 1; if (l.status === 'lost') chance = 0;
    if (l.status === 'void') chance = 1;
    return { id: l.id, player: p.name, playerId: p.id, stat: l.stat, line: l.line, side: l.side, odds: l.odds,
      status: l.status, result: l.result, soFar, chance, fixture: fixtureRow(f) };
  });
  // Cash out: what the bet is worth right now, minus 10%
  let cashout = 0;
  if (b.status === 'open' && legs.every(l => l.status !== 'lost')) {
    const prob = legs.reduce((a, l) => a * l.chance, 1);
    const oddsLive = legs.filter(l => l.status !== 'void').reduce((a, l) => a * l.odds, 1);
    cashout = Math.max(0, Math.round(b.stake * oddsLive * prob * 0.9));
  }
  return { id: b.id, stake: b.stake, odds: b.odds, potential: b.potential, status: b.status, payout: b.payout,
    created: b.created, settledAt: b.settled_at, legs, cashout };
}

const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };

// ---------- accounts ----------
app.post('/api/signup', wrap((req, res) => res.json({ token: auth.signup(req.body.username, req.body.password) })));
app.post('/api/login', wrap((req, res) => res.json({ token: auth.login(req.body.username, req.body.password) })));
app.post('/api/logout', auth.requireUser, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});
app.get('/api/me', auth.requireUser, (req, res) => res.json(publicUser(req.user)));

// ---------- matches and markets ----------
app.get('/api/fixtures', (req, res) => {
  const live = db.prepare("SELECT * FROM fixtures WHERE status = 'LIVE' ORDER BY kickoff").all();
  const next = db.prepare("SELECT * FROM fixtures WHERE status = 'NS' ORDER BY kickoff LIMIT 30").all();
  const done = db.prepare("SELECT * FROM fixtures WHERE status IN ('FT','OFF') ORDER BY kickoff DESC LIMIT 10").all();
  res.json({ live: live.map(fixtureRow), next: next.map(fixtureRow), done: done.map(fixtureRow) });
});

app.get('/api/fixture/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM fixtures WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Match not found' });
  const events = db.prepare('SELECT * FROM events WHERE fixture_id = ? ORDER BY id DESC LIMIT 40').all(f.id);
  res.json({ fixture: fixtureRow(f), events, players: pricedPlayers(f).map(p => market(p, f)) });
});

// Today's card: every priced player in every open match
app.get('/api/card', (req, res) => {
  const league = req.query.league ? parseInt(req.query.league, 10) : null;
  const rows = [];
  for (const f of openFixtures()) {
    if (league && f.league_id !== league) continue;
    const fx = fixtureRow(f);
    for (const p of pricedPlayers(f)) rows.push({ ...market(p, f), fixture: fx });
  }
  res.json({ rows: rows.filter(r => r.bettable).slice(0, 200) });
});

app.get('/api/player/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Player not found' });
  const f = db.prepare("SELECT * FROM fixtures WHERE status IN ('NS','LIVE') AND (home_id = ? OR away_id = ?) ORDER BY kickoff LIMIT 1").get(p.team_id, p.team_id);
  const team = (db.prepare('SELECT name FROM teams WHERE id = ?').get(p.team_id) || {}).name;
  // Form: stored history, plus finished matches we have tracked
  const tracked = db.prepare(`SELECT s.shots, s.saves FROM player_stats s JOIN fixtures f ON f.id = s.fixture_id
    WHERE s.player_id = ? AND f.status = 'FT' AND s.minutes > 0 ORDER BY f.kickoff`).all(p.id).map(s => s[statOf(p)]);
  const form = JSON.parse(p.form || '[]').concat(tracked).slice(-10);
  const out = { id: p.id, name: p.name, team, position: p.position, stat: statOf(p), avg: p.avg, apps: p.apps, form, fixture: null, lines: [], sameMatch: [] };
  if (f) {
    out.fixture = fixtureRow(f);
    out.lines = allLines(p.avg).map(l => market(p, f, l));
    out.sameMatch = pricedPlayers(f).filter(x => x.id !== p.id).slice(0, 6).map(x => market(x, f));
  }
  res.json(out);
});

app.get('/api/search', (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%';
  res.json(db.prepare(`SELECT p.id, p.name, t.name team FROM players p JOIN teams t ON t.id = p.team_id
    WHERE p.name LIKE ? AND p.avg > 0 AND p.apps >= 5 LIMIT 10`).all(q));
});

app.get('/api/leagues', (req, res) => {
  res.json(db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM fixtures f WHERE f.league_id = l.id AND f.status IN ('NS','LIVE')) open
    FROM leagues l ORDER BY l.id`).all());
});

app.get('/api/leaderboard', (req, res) => {
  res.json(db.prepare('SELECT username, points, streak, best_streak bestStreak FROM users ORDER BY points DESC LIMIT 20').all());
});

// ---------- bets ----------
app.post('/api/bets', auth.requireUser, wrap((req, res) => {
  const u = req.user;
  const stake = parseInt(req.body.stake, 10);
  const picks = Array.isArray(req.body.legs) ? req.body.legs : [];
  if (u.break_until > Date.now()) throw new Error('You are on a break until ' + new Date(u.break_until).toLocaleString());
  if (!stake || stake < MIN_STAKE) throw new Error(`Minimum stake is ${MIN_STAKE} points`);
  if (stake > u.points) throw new Error('Not enough points');
  if (stakedToday(u.id) + stake > u.daily_limit) throw new Error(`That goes over your daily limit of ${u.daily_limit} points`);
  if (picks.length < 1 || picks.length > MAX_LEGS) throw new Error(`Pick 1 to ${MAX_LEGS} players`);
  if (new Set(picks.map(p => p.playerId)).size !== picks.length) throw new Error('One pick per player in a slip');

  const legs = [];
  const moved = [];
  for (const pick of picks) {
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(pick.playerId);
    const f = db.prepare('SELECT * FROM fixtures WHERE id = ?').get(pick.fixtureId);
    if (!p || !f) throw new Error('A pick is no longer available');
    if (![f.home_id, f.away_id].includes(p.team_id)) throw new Error(`${p.name} is not in that match`);
    if (!['more', 'less'].includes(pick.side)) throw new Error('Pick more or less');
    const line = Number(pick.line);
    if (!allLines(p.avg).includes(line)) throw new Error(`Line ${line} is not offered for ${p.name}`);
    const m = market(p, f, line);
    if (!m.bettable) throw new Error(`${p.name} ${line} is closed`);
    const odds = m[pick.side];
    if (Math.abs(odds - Number(pick.odds)) > ODDS_TOLERANCE) moved.push({ playerId: p.id, odds });
    legs.push({ f, p, line, side: pick.side, odds, stat: statOf(p) });
  }
  if (moved.length) return res.status(409).json({ error: 'Odds moved. Check the new prices and place again.', moved });

  const total = Math.round(legs.reduce((a, l) => a * l.odds, 1) * 100) / 100;
  const potential = Math.round(stake * total);
  const betId = db.transaction(() => {
    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(stake, u.id);
    const id = db.prepare('INSERT INTO bets (user_id, stake, odds, potential, created) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, stake, total, potential, Date.now()).lastInsertRowid;
    for (const l of legs) {
      db.prepare('INSERT INTO legs (bet_id, fixture_id, player_id, stat, line, side, odds) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, l.f.id, l.p.id, l.stat, l.line, l.side, l.odds);
    }
    return id;
  })();
  res.json({ bet: betView(db.prepare('SELECT * FROM bets WHERE id = ?').get(betId)),
    me: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
}));

app.get('/api/bets', auth.requireUser, (req, res) => {
  const all = db.prepare('SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id).map(betView);
  const settled = all.filter(b => b.status !== 'open');
  const won = settled.filter(b => b.status === 'won' || b.status === 'cashed');
  const staked = settled.reduce((a, b) => a + b.stake, 0);
  const returned = settled.reduce((a, b) => a + b.payout, 0);
  res.json({ open: all.filter(b => b.status === 'open'), settled,
    stats: { winRate: settled.length ? Math.round(won.length / settled.length * 100) : 0, staked, returned, profit: returned - staked } });
});

app.post('/api/bets/:id/cashout', auth.requireUser, wrap((req, res) => {
  const b = db.prepare("SELECT * FROM bets WHERE id = ? AND user_id = ? AND status = 'open'").get(req.params.id, req.user.id);
  if (!b) throw new Error('That bet cannot be cashed out');
  const value = betView(b).cashout;
  if (value <= 0) throw new Error('No cash out available on this bet');
  db.transaction(() => {
    db.prepare("UPDATE bets SET status = 'cashed', payout = ?, settled_at = ? WHERE id = ?").run(value, Date.now(), b.id);
    db.prepare("UPDATE legs SET status = 'void' WHERE bet_id = ? AND status = 'open'").run(b.id);
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(value, req.user.id);
  })();
  res.json({ cashed: value, me: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
}));

// ---------- play safe ----------
app.post('/api/limits', auth.requireUser, wrap((req, res) => {
  const limit = parseInt(req.body.dailyLimit, 10);
  if (limit) {
    if (limit < 50 || limit > 100000) throw new Error('Daily limit must be between 50 and 100000');
    db.prepare('UPDATE users SET daily_limit = ? WHERE id = ?').run(limit, req.user.id);
  }
  const hours = parseInt(req.body.breakHours, 10);
  if (hours && ![24, 168, 720].includes(hours)) throw new Error('Break must be 24 hours, 7 days or 30 days');
  if (hours) db.prepare('UPDATE users SET break_until = ? WHERE id = ?').run(Date.now() + hours * 3600000, req.user.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
}));

app.post('/api/refill', auth.requireUser, wrap((req, res) => {
  const u = req.user;
  if (u.points >= 100) throw new Error('Refill unlocks when you drop under 100 points');
  if (Date.now() - u.refill_at < 86400000) throw new Error('One refill a day');
  db.prepare('UPDATE users SET points = points + 1000, refill_at = ? WHERE id = ?').run(Date.now(), u.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
}));

// ---------- live push (Server-Sent Events) ----------
app.get('/api/stream', (req, res) => {
  const user = auth.userFromToken(req.query.token);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = msg => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const onAll = msg => send(msg);
  const onUser = (id, msg) => { if (user && id === user.id) send(msg); };
  bus.on('all', onAll); bus.on('user', onUser);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { bus.off('all', onAll); bus.off('user', onUser); clearInterval(ping); });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`\ncope is running: open http://localhost:${PORT}\n`);
  if (TEST) require('./testmode').start(); else require('./live').start();
  settle.start();
});
