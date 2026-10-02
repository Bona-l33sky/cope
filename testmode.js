// TEST MODE: practice matches for when you have no API key yet, or no real games are on.
// Same app, same bets, same settlement. Only the match feed is generated instead of pulled live.
// Start it with: npm run test-mode
const db = require('./db');
const bus = require('./bus');

const MINUTE_MS = parseInt(process.env.TEST_MINUTE_MS || '6000', 10); // 1 match minute = 6 real seconds
const GAP_MS = 2 * 60 * 1000;                                         // a new kick-off every 2 minutes

const SQUADS = {
  'Premier League|England|#22D39A': {
    Arsenal: [['Bukayo Saka', 3.1], ['Martin Ødegaard', 1.9], ['Kai Havertz', 2.6], ['Gabriel Martinelli', 2.2], ['David Raya', 2.4, 'GK']],
    Tottenham: [['Dominic Solanke', 2.4], ['Mohammed Kudus', 2.3], ['Richarlison', 2.0], ['Xavi Simons', 2.1], ['Guglielmo Vicario', 3.6, 'GK']],
    Liverpool: [['Mohamed Salah', 3.4], ['Florian Wirtz', 2.2], ['Hugo Ekitike', 2.6], ['Cody Gakpo', 2.3], ['Alisson', 2.6, 'GK']],
    'Manchester City': [['Erling Haaland', 3.6], ['Phil Foden', 2.4], ['Omar Marmoush', 2.5], ['Jérémy Doku', 1.8], ['Gianluigi Donnarumma', 2.5, 'GK']]
  },
  'La Liga|Spain|#F5A524': {
    'Real Madrid': [['Kylian Mbappé', 4.1], ['Vinícius Júnior', 3.2], ['Jude Bellingham', 2.2], ['Rodrygo', 2.1], ['Thibaut Courtois', 2.8, 'GK']],
    Barcelona: [['Robert Lewandowski', 3.3], ['Lamine Yamal', 3.0], ['Raphinha', 2.8], ['Pedri', 1.4], ['Joan García', 2.7, 'GK']],
    'Atlético Madrid': [['Julián Álvarez', 3.0], ['Antoine Griezmann', 2.2], ['Alexander Sørloth', 2.4], ['Álex Baena', 1.7], ['Jan Oblak', 3.0, 'GK']],
    'Athletic Club': [['Nico Williams', 2.4], ['Gorka Guruzeta', 2.0], ['Oihan Sancet', 1.9], ['Iñaki Williams', 2.1], ['Unai Simón', 2.9, 'GK']]
  },
  'Serie A|Italy|#5BC8F5': {
    Inter: [['Lautaro Martínez', 3.4], ['Marcus Thuram', 2.6], ['Hakan Çalhanoğlu', 1.8], ['Federico Dimarco', 1.5], ['Yann Sommer', 2.5, 'GK']],
    Napoli: [['Rasmus Højlund', 2.4], ['Scott McTominay', 2.3], ['Kevin De Bruyne', 2.0], ['Matteo Politano', 1.7], ['Alex Meret', 2.7, 'GK']],
    Milan: [['Rafael Leão', 2.8], ['Christian Pulisic', 2.5], ['Santiago Giménez', 2.3], ['Luka Modrić', 1.1], ['Mike Maignan', 3.0, 'GK']],
    Juventus: [['Dušan Vlahović', 2.9], ['Kenan Yıldız', 2.4], ['Jonathan David', 2.3], ['Francisco Conceição', 2.0], ['Michele Di Gregorio', 2.8, 'GK']]
  },
  'Bundesliga|Germany|#FF6B5A': {
    'Bayern Munich': [['Harry Kane', 4.0], ['Michael Olise', 2.6], ['Luis Díaz', 2.5], ['Serge Gnabry', 2.0], ['Manuel Neuer', 2.2, 'GK']],
    'Borussia Dortmund': [['Serhou Guirassy', 3.3], ['Karim Adeyemi', 2.3], ['Julian Brandt', 1.9], ['Maximilian Beier', 2.0], ['Gregor Kobel', 3.0, 'GK']],
    'Bayer Leverkusen': [['Patrik Schick', 2.8], ['Alejandro Grimaldo', 1.8], ['Malik Tillman', 2.0], ['Christian Kofane', 1.9], ['Mark Flekken', 2.9, 'GK']],
    'VfB Stuttgart': [['Deniz Undav', 2.7], ['Ermedin Demirović', 2.5], ['Chris Führich', 1.8], ['Jamie Leweling', 1.7], ['Alexander Nübel', 3.1, 'GK']]
  },
  'Ligue 1|France|#8B7DFF': {
    'Paris Saint-Germain': [['Ousmane Dembélé', 3.4], ['Khvicha Kvaratskhelia', 2.8], ['Bradley Barcola', 2.6], ['Désiré Doué', 2.3], ['Lucas Chevalier', 2.2, 'GK']],
    Marseille: [['Pierre-Emerick Aubameyang', 2.8], ['Mason Greenwood', 3.0], ['Amine Gouiri', 2.4], ['Igor Paixão', 1.9], ['Gerónimo Rulli', 3.0, 'GK']],
    Monaco: [['Ansu Fati', 2.0], ['Maghnes Akliouche', 2.1], ['Mika Biereth', 2.6], ['Aleksandr Golovin', 1.6], ['Philipp Köhn', 3.1, 'GK']],
    Lens: [['Florian Thauvin', 2.2], ['Wesley Saïd', 2.0], ['Odsonne Édouard', 2.1], ['Adrien Thomasson', 1.4], ['Robin Risser', 3.2, 'GK']]
  },
  'Eredivisie|Netherlands|#FF8C3A': {
    Ajax: [['Wout Weghorst', 2.6], ['Mika Godts', 2.2], ['Oscar Gloukh', 1.9], ['Kenneth Taylor', 1.6], ['Vítězslav Jaroš', 3.0, 'GK']],
    PSV: [['Guus Til', 2.4], ['Ismael Saibari', 2.5], ['Ricardo Pepi', 2.6], ['Couhaib Driouech', 2.0], ['Matěj Kovář', 2.6, 'GK']],
    Feyenoord: [['Ayase Ueda', 3.0], ['Anis Hadj Moussa', 2.3], ['Leo Sauer', 1.9], ['Quinten Timber', 1.4], ['Timon Wellenreuther', 2.9, 'GK']],
    'AZ Alkmaar': [['Troy Parrott', 2.8], ['Sven Mijnans', 2.0], ['Ibrahim Sadiq', 1.8], ['Jordy Clasie', 0.9], ['Rome-Jayden Owusu-Oduro', 3.1, 'GK']]
  }
};

function poisson(lam) { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }

function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM players').get().n > 0) return;
  let lid = 1, tid = 1, pid = 1;
  for (const [key, teams] of Object.entries(SQUADS)) {
    const [name, country, color] = key.split('|');
    db.prepare('INSERT INTO leagues (id, name, country, color) VALUES (?, ?, ?, ?)').run(lid, name, country, color);
    for (const [team, players] of Object.entries(teams)) {
      db.prepare('INSERT INTO teams (id, league_id, name) VALUES (?, ?, ?)').run(tid, lid, team);
      for (const [pname, avg, pos] of players) {
        const form = Array.from({ length: 10 }, () => poisson(avg));
        db.prepare('INSERT INTO players (id, team_id, name, position, avg, apps, form) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(pid++, tid, pname, pos || 'OUT', avg, 7, JSON.stringify(form));
      }
      tid++;
    }
    lid++;
  }
  console.log('[test] practice squads loaded');
}

// Keep at least 4 matches waiting to kick off, each 2 minutes apart
function schedule() {
  const waiting = db.prepare("SELECT COUNT(*) n FROM fixtures WHERE status = 'NS'").get().n;
  for (let i = waiting; i < 4; i++) {
    const last = db.prepare("SELECT MAX(kickoff) k FROM fixtures WHERE status IN ('NS','LIVE')").get().k || Date.now();
    const busy = new Set(db.prepare("SELECT home_id, away_id FROM fixtures WHERE status IN ('NS','LIVE')").all().flatMap(f => [f.home_id, f.away_id]));
    const leagues = db.prepare('SELECT id FROM leagues ORDER BY RANDOM()').all();
    for (const l of leagues) {
      const free = db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY RANDOM()').all(l.id).filter(t => !busy.has(t.id));
      if (free.length >= 2) {
        db.prepare('INSERT INTO fixtures (league_id, home_id, away_id, kickoff, status, venue) VALUES (?, ?, ?, ?, ?, ?)')
          .run(l.id, free[0].id, free[1].id, Math.max(last + GAP_MS, Date.now() + 60000), 'NS', 'practice ground');
        break;
      }
    }
  }
}

function tick() {
  const now = Date.now();
  // Kick-offs: decide who plays (about 1 in 20 is benched, so voids happen like real life)
  for (const f of db.prepare("SELECT * FROM fixtures WHERE status = 'NS' AND kickoff <= ?").all(now)) {
    db.prepare("UPDATE fixtures SET status = 'LIVE', minute = 0 WHERE id = ?").run(f.id);
    const squad = db.prepare('SELECT id FROM players WHERE team_id IN (?, ?)').all(f.home_id, f.away_id);
    for (const p of squad) {
      if (Math.random() < 0.05) continue;
      db.prepare('INSERT OR IGNORE INTO player_stats (fixture_id, player_id) VALUES (?, ?)').run(f.id, p.id);
    }
    db.prepare('INSERT INTO events (fixture_id, minute, text, kind, created) VALUES (?, 0, ?, ?, ?)').run(f.id, 'Kick off.', 'info', now);
  }
  // Live minutes
  for (const f of db.prepare("SELECT * FROM fixtures WHERE status = 'LIVE'").all()) {
    const minute = f.minute + 1;
    const ev = db.prepare('INSERT INTO events (fixture_id, minute, text, player_id, kind, created) VALUES (?, ?, ?, ?, ?, ?)');
    const playing = db.prepare(`SELECT p.*, s.shots, s.saves FROM player_stats s JOIN players p ON p.id = s.player_id WHERE s.fixture_id = ?`).all(f.id);
    db.prepare('UPDATE player_stats SET minutes = ? WHERE fixture_id = ?').run(minute, f.id);
    let hg = f.home_goals, ag = f.away_goals;
    for (const p of playing.filter(x => x.position === 'OUT')) {
      if (Math.random() > p.avg / 90) continue;
      const shots = p.shots + 1;
      db.prepare('UPDATE player_stats SET shots = ? WHERE fixture_id = ? AND player_id = ?').run(shots, f.id, p.id);
      const oppTeam = p.team_id === f.home_id ? f.away_id : f.home_id;
      const keeper = playing.find(x => x.position === 'GK' && x.team_id === oppTeam);
      const r = Math.random();
      if (r < 0.62 || !keeper) {
        ev.run(f.id, minute, `${p.name} shot ${r < 0.3 ? 'off target' : 'blocked'}. Counts. Now on ${shots}.`, p.id, 'shot', now);
      } else if (r < 0.88) {
        ev.run(f.id, minute, `${p.name} shot on target. Now on ${shots}.`, p.id, 'shot', now);
        const saves = keeper.saves + 1; keeper.saves = saves;
        db.prepare('UPDATE player_stats SET saves = ? WHERE fixture_id = ? AND player_id = ?').run(saves, f.id, keeper.id);
        ev.run(f.id, minute, `${keeper.name} save. Now on ${saves}.`, keeper.id, 'save', now);
      } else {
        if (p.team_id === f.home_id) hg++; else ag++;
        ev.run(f.id, minute, `GOAL. ${p.name} scores. Shot counts, now on ${shots}.`, p.id, 'goal', now);
      }
      p.shots = shots;
    }
    const end = minute >= 90 + (f.id % 4); // a little stoppage time
    db.prepare('UPDATE fixtures SET minute = ?, home_goals = ?, away_goals = ?, status = ?, ended_at = ? WHERE id = ?')
      .run(minute, hg, ag, end ? 'FT' : 'LIVE', end ? now : null, f.id);
    if (end) ev.run(f.id, minute, 'Full time.', null, 'info', now);
  }
  schedule();
  bus.emit('all', { type: 'update' });
}

function start() {
  console.log(`[test] TEST MODE on: practice matches, 1 match minute every ${MINUTE_MS / 1000}s`);
  seed(); schedule(); tick();
  setInterval(tick, MINUTE_MS);
}

module.exports = { start };
