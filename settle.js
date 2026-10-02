// Settlement: after full time (plus the delay), every leg on that match is marked won, lost or void,
// then every finished bet pays out. Runs every 30 seconds.
const db = require('./db');
const bus = require('./bus');

const DELAY_MS = parseFloat(process.env.SETTLE_DELAY_MINUTES || '30') * 60 * 1000;

function settleFixture(f) {
  const legs = db.prepare("SELECT * FROM legs WHERE fixture_id = ? AND status = 'open'").all(f.id);
  const mark = db.prepare('UPDATE legs SET status = ?, result = ? WHERE id = ?');
  for (const leg of legs) {
    if (f.status === 'OFF') { mark.run('void', null, leg.id); continue; }  // postponed or abandoned
    const st = db.prepare('SELECT * FROM player_stats WHERE fixture_id = ? AND player_id = ?').get(f.id, leg.player_id);
    if (!st || st.minutes <= 0) { mark.run('void', null, leg.id); continue; } // never came on: points back
    const count = leg.stat === 'saves' ? st.saves : st.shots;
    const won = leg.side === 'more' ? count > leg.line : count < leg.line;
    mark.run(won ? 'won' : 'lost', count, leg.id);
  }
  db.prepare('UPDATE fixtures SET settled = 1 WHERE id = ?').run(f.id);
}

function settleBets() {
  const open = db.prepare("SELECT * FROM bets WHERE status = 'open'").all();
  for (const bet of open) {
    const legs = db.prepare('SELECT * FROM legs WHERE bet_id = ?').all(bet.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(bet.user_id);
    let status = null, payout = 0;

    if (legs.some(l => l.status === 'lost')) status = 'lost';
    else if (legs.every(l => l.status !== 'open')) {
      const live = legs.filter(l => l.status === 'won');
      if (live.length === 0) { status = 'void'; payout = bet.stake; }
      else {
        const odds = live.reduce((a, l) => a * l.odds, 1);
        status = 'won'; payout = Math.round(bet.stake * odds);
      }
    }
    if (!status) continue;

    // Streak counts bets, not matchdays: win adds one, loss resets, void changes nothing
    let streak = user.streak;
    if (status === 'won') streak += 1;
    if (status === 'lost') streak = 0;

    db.transaction(() => {
      db.prepare('UPDATE bets SET status = ?, payout = ?, settled_at = ? WHERE id = ?').run(status, payout, Date.now(), bet.id);
      db.prepare('UPDATE users SET points = points + ?, streak = ?, best_streak = MAX(best_streak, ?) WHERE id = ?')
        .run(payout, streak, streak, user.id);
    })();
    bus.emit('user', user.id, { type: 'settled', betId: bet.id, status, payout, streak });
  }
}

function run() {
  const due = db.prepare(
    "SELECT * FROM fixtures WHERE settled = 0 AND ((status = 'FT' AND ended_at <= ?) OR status = 'OFF')"
  ).all(Date.now() - DELAY_MS);
  due.forEach(settleFixture);
  settleBets();
  if (due.length) bus.emit('all', { type: 'update' });
}

function start() { run(); setInterval(run, 30 * 1000); }

module.exports = { start, run };
