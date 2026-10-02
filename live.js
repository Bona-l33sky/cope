// LIVE STATS: pulls real fixtures, squads and live player stats from API-Football (api-sports.io).
// Real matches, real shots, real saves. Only the money is pretend (points).
const db = require('./db');
const bus = require('./bus');

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const LEAGUES = (process.env.LEAGUES || '39,140,135,78,61,88').split(',').map(s => parseInt(s.trim(), 10));
const SEASON = parseInt(process.env.SEASON || '2026', 10);
const POLL_MS = parseInt(process.env.LIVE_POLL_SECONDS || '60', 10) * 1000;

const COLORS = { 39: '#22D39A', 140: '#F5A524', 135: '#5BC8F5', 78: '#FF6B5A', 61: '#8B7DFF', 88: '#FF8C3A' };
const LIVE_CODES = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT'];
const DONE_CODES = ['FT', 'AET', 'PEN'];
const OFF_CODES = ['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP'];

let used = 0; // requests used today (shown in the server log)

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': KEY } });
  used++;
  const left = res.headers.get('x-ratelimit-requests-remaining');
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error('API-Football said: ' + JSON.stringify(json.errors));
  }
  if (left !== null && parseInt(left, 10) < 20) console.warn(`[live] only ${left} API requests left today`);
  return json;
}

function mapStatus(code) {
  if (LIVE_CODES.includes(code)) return 'LIVE';
  if (DONE_CODES.includes(code)) return 'FT';
  if (OFF_CODES.includes(code)) return 'OFF';
  return 'NS';
}

function dateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

// 1) Fixtures for today and tomorrow in our leagues
async function syncFixtures() {
  const upLeague = db.prepare('INSERT INTO leagues (id, name, country, color) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name');
  const upTeam = db.prepare('INSERT INTO teams (id, league_id, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name');
  const upFx = db.prepare(`INSERT INTO fixtures (id, league_id, home_id, away_id, kickoff, status, minute, home_goals, away_goals, venue, ended_at)
    VALUES (@id, @league_id, @home_id, @away_id, @kickoff, @status, @minute, @hg, @ag, @venue, @ended)
    ON CONFLICT(id) DO UPDATE SET kickoff = excluded.kickoff, status = excluded.status, minute = excluded.minute,
    home_goals = excluded.home_goals, away_goals = excluded.away_goals,
    ended_at = COALESCE(fixtures.ended_at, excluded.ended_at)`);

  for (const league of LEAGUES) {
    for (const day of [0, 1]) {
      const json = await api('/fixtures', { league, season: SEASON, date: dateStr(day) });
      for (const r of json.response || []) {
        upLeague.run(r.league.id, r.league.name, r.league.country, COLORS[r.league.id] || '#8B7DFF');
        upTeam.run(r.teams.home.id, r.league.id, r.teams.home.name);
        upTeam.run(r.teams.away.id, r.league.id, r.teams.away.name);
        upFx.run({
          id: r.fixture.id, league_id: r.league.id, home_id: r.teams.home.id, away_id: r.teams.away.id,
          kickoff: new Date(r.fixture.date).getTime(), status: mapStatus(r.fixture.status.short),
          minute: r.fixture.status.elapsed || 0, hg: r.goals.home || 0, ag: r.goals.away || 0,
          venue: r.fixture.venue ? r.fixture.venue.name : '',
          ended: mapStatus(r.fixture.status.short) === 'FT' ? Date.now() : null
        });
      }
    }
  }
  // Squads for any team playing soon that we have not loaded today
  const teams = db.prepare(`SELECT DISTINCT t.id FROM teams t JOIN fixtures f ON (f.home_id = t.id OR f.away_id = t.id)
    WHERE f.status IN ('NS','LIVE') AND t.squad_synced < ?`).all(Date.now() - 86400000);
  for (const t of teams) await syncSquad(t.id);
  console.log(`[live] fixtures synced. API requests used since start: ${used}`);
  bus.emit('all', { type: 'update' });
}

// 2) Squad + season averages. A player is priced only with 5+ league appearances.
async function syncSquad(teamId) {
  const up = db.prepare(`INSERT INTO players (id, team_id, name, position, avg, apps) VALUES (@id, @team, @name, @pos, @avg, @apps)
    ON CONFLICT(id) DO UPDATE SET team_id = excluded.team_id, avg = excluded.avg, apps = excluded.apps, position = excluded.position`);
  let page = 1, total = 1;
  do {
    const json = await api('/players', { team: teamId, season: SEASON, page });
    total = (json.paging && json.paging.total) || 1;
    for (const r of json.response || []) {
      // Use the league entry with the most appearances
      const s = (r.statistics || []).slice().sort((a, b) => (b.games.appearences || 0) - (a.games.appearences || 0))[0];
      if (!s) continue;
      const apps = s.games.appearences || 0;
      const isGK = s.games.position === 'Goalkeeper';
      const count = isGK ? (s.goals.saves || 0) : (s.shots.total || 0);
      up.run({ id: r.player.id, team: teamId, name: r.player.name, pos: isGK ? 'GK' : 'OUT', avg: apps ? +(count / apps).toFixed(2) : 0, apps });
    }
    page++;
  } while (page <= total);
  db.prepare('UPDATE teams SET squad_synced = ? WHERE id = ?').run(Date.now(), teamId);
}

// 3) Live poll: scores, minutes, and every player's shots and saves
async function pollLive() {
  const json = await api('/fixtures', { live: LEAGUES.join('-') });
  const liveIds = new Set();
  for (const r of json.response || []) {
    liveIds.add(r.fixture.id);
    const st = mapStatus(r.fixture.status.short);
    db.prepare('UPDATE fixtures SET status = ?, minute = ?, home_goals = ?, away_goals = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?')
      .run(st, r.fixture.status.elapsed || 0, r.goals.home || 0, r.goals.away || 0, st === 'FT' ? Date.now() : null, r.fixture.id);
    await pollPlayers(r.fixture.id, r.fixture.status.elapsed || 0);
  }
  // Matches we thought were live but are no longer in the live list: fetch final state once
  const stale = db.prepare("SELECT id FROM fixtures WHERE status = 'LIVE'").all().filter(f => !liveIds.has(f.id));
  for (const f of stale) {
    const one = await api('/fixtures', { id: f.id });
    const r = (one.response || [])[0];
    if (!r) continue;
    const st = mapStatus(r.fixture.status.short);
    await pollPlayers(f.id, r.fixture.status.elapsed || 90);
    db.prepare('UPDATE fixtures SET status = ?, minute = ?, home_goals = ?, away_goals = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?')
      .run(st, r.fixture.status.elapsed || 90, r.goals.home || 0, r.goals.away || 0, st === 'FT' ? Date.now() : null, f.id);
  }
  // Kick-off: matches that started since the last fixtures sync
  const startedNS = db.prepare("SELECT id FROM fixtures WHERE status = 'NS' AND kickoff < ?").all(Date.now() - 5 * 60000);
  if (startedNS.length && !liveIds.size) await syncFixtures();
  bus.emit('all', { type: 'update' });
}

async function pollPlayers(fixtureId, minute) {
  const json = await api('/fixtures/players', { fixture: fixtureId });
  const get = db.prepare('SELECT * FROM player_stats WHERE fixture_id = ? AND player_id = ?');
  const up = db.prepare(`INSERT INTO player_stats (fixture_id, player_id, minutes, shots, saves) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(fixture_id, player_id) DO UPDATE SET minutes = excluded.minutes, shots = excluded.shots, saves = excluded.saves`);
  const addEv = db.prepare('INSERT INTO events (fixture_id, minute, text, player_id, kind, created) VALUES (?, ?, ?, ?, ?, ?)');
  const ensurePlayer = db.prepare(`INSERT OR IGNORE INTO players (id, team_id, name, position, avg, apps) VALUES (?, ?, ?, ?, 0, 0)`);

  for (const team of json.response || []) {
    for (const p of team.players || []) {
      const s = (p.statistics || [])[0];
      if (!s) continue;
      const isGK = s.games.position === 'G';
      ensurePlayer.run(p.player.id, team.team.id, p.player.name, isGK ? 'GK' : 'OUT');
      const minutes = s.games.minutes || 0;
      const shots = (s.shots && s.shots.total) || 0;
      const saves = (s.goals && s.goals.saves) || 0;
      const before = get.get(fixtureId, p.player.id) || { shots: 0, saves: 0 };
      if (shots > before.shots) addEv.run(fixtureId, minute, `${p.player.name} shot. Counts. Now on ${shots}.`, p.player.id, 'shot', Date.now());
      if (saves > before.saves) addEv.run(fixtureId, minute, `${p.player.name} save. Now on ${saves}.`, p.player.id, 'save', Date.now());
      up.run(fixtureId, p.player.id, minutes, shots, saves);
    }
  }
}

function safe(fn, name) {
  return () => fn().catch(e => console.error(`[live] ${name} failed:`, e.message));
}

function start() {
  if (!KEY) {
    console.error('\n[live] No API_FOOTBALL_KEY in your .env file. Add it, or run "npm run test-mode" to practise.\n');
    process.exit(1);
  }
  console.log(`[live] Live stats ON. Leagues ${LEAGUES.join(', ')}, season ${SEASON}, polling every ${POLL_MS / 1000}s`);
  safe(syncFixtures, 'fixtures')();
  setInterval(safe(syncFixtures, 'fixtures'), 3 * 60 * 60 * 1000); // every 3 hours
  setInterval(() => {
    const anyLive = db.prepare("SELECT COUNT(*) n FROM fixtures WHERE status = 'LIVE' OR (status = 'NS' AND kickoff < ?)").get(Date.now() + 60000).n;
    if (anyLive) safe(pollLive, 'live poll')();
  }, POLL_MS);
}

module.exports = { start };
