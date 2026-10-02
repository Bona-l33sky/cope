// cope front end: talks to the server API, updates live through /api/stream.
const S = { token: localStorage.getItem('cope_token'), me: null, page: 'today', slip: [], league: null,
  focus: null, playerId: null, stake: 50 };

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => Number(n || 0).toLocaleString();
const ini = n => esc(String(n || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase());
const time = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const statWord = (s, n) => s === 'saves' ? (n === 1 ? 'save' : 'saves') : (n === 1 ? 'shot' : 'shots');

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (S.token || '') },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login' && path !== '/signup') { logout(); throw new Error('Please log in'); }
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.data = data; e.status = res.status; throw e; }
  return data;
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2800); }

function confetti() {
  const c = $('confetti'), x = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
  const cols = ['#6C5CFF', '#22D3EE', '#00E07A', '#FFC53D', '#FF4D6A'];
  const bits = Array.from({ length: 140 }, () => ({ x: innerWidth / 2, y: innerHeight / 2, vx: (Math.random() - .5) * 16, vy: Math.random() * -16 - 4, r: Math.random() * 6 + 3, c: cols[Math.random() * 5 | 0] }));
  let f = 0; (function draw() { x.clearRect(0, 0, c.width, c.height);
    bits.forEach(b => { b.x += b.vx; b.y += b.vy; b.vy += .5; x.fillStyle = b.c; x.fillRect(b.x, b.y, b.r, b.r * .6); });
    if (++f < 90) requestAnimationFrame(draw); else x.clearRect(0, 0, c.width, c.height); })();
}

// ---------- auth ----------
async function doAuth(kind) {
  $('au-err').textContent = '';
  try {
    const r = await api('/' + kind, { method: 'POST', body: { username: $('au-user').value, password: $('au-pass').value } });
    S.token = r.token; localStorage.setItem('cope_token', r.token); boot();
  } catch (e) { $('au-err').textContent = e.message; }
}
$('au-login').onclick = () => doAuth('login');
$('au-signup').onclick = () => doAuth('signup');
$('au-pass').onkeydown = e => { if (e.key === 'Enter') doAuth('login'); };
function logout() { api('/logout', { method: 'POST' }).catch(() => {}); S.token = null; localStorage.removeItem('cope_token'); $('app').classList.add('hidden'); $('auth').classList.remove('hidden'); }
$('logout').onclick = logout;

async function loadMe() {
  S.me = await api('/me');
  $('points').textContent = fmt(S.me.points); $('streak').textContent = S.me.streak;
  const mp = $('mode-pill'); mp.textContent = S.me.mode === 'test' ? 'test mode' : '● live stats'; mp.classList.toggle('test', S.me.mode === 'test');
}

// ---------- navigation ----------
function go(page) {
  S.page = page;
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  $('p-' + page).classList.remove('hidden');
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  $('slip-fab').classList.toggle('hidden', !(page === 'card' || page === 'player') || !S.slip.length);
  render();
}
document.querySelectorAll('[data-page]').forEach(a => a.onclick = () => go(a.dataset.page));
function openPlayer(id) { S.playerId = id; go('player'); }
function focusMatch(id) { S.focus = id; go('today'); }
window.openPlayer = openPlayer; window.focusMatch = focusMatch;

function render() {
  const r = { today: rToday, card: rCard, player: rPlayer, portfolio: rPortfolio, leagues: rLeagues }[S.page];
  r().catch(e => console.error(e));
}

// ---------- slip ----------
function inSlip(pid) { return S.slip.find(x => x.playerId === pid); }
function toggle(m, side, fixtureId) {
  const have = inSlip(m.playerId);
  if (have && have.side === side && have.line === m.line) S.slip = S.slip.filter(x => x.playerId !== m.playerId);
  else {
    if (!have && S.slip.length >= 5) return toast('Max 5 picks in one slip');
    S.slip = S.slip.filter(x => x.playerId !== m.playerId);
    S.slip.push({ playerId: m.playerId, fixtureId, name: m.name, stat: m.stat, line: m.line, side, odds: m[side] });
  }
  drawSlip(); render();
}
window._toggle = (enc, side, fid) => toggle(JSON.parse(decodeURIComponent(enc)), side, fid);

function oddsBtns(m, fid) {
  const enc = encodeURIComponent(JSON.stringify({ playerId: m.playerId, name: m.name, stat: m.stat, line: m.line, more: m.more, less: m.less }));
  const s = inSlip(m.playerId);
  const sel = side => s && s.side === side && s.line === m.line ? 'sel' : '';
  const dis = m.bettable ? '' : 'disabled';
  return `<div class="ml">
    <button class="ob ${sel('more')}" ${dis} onclick="_toggle('${enc}','more',${fid})"><small>more</small><b>${m.more.toFixed(2)}</b></button>
    <button class="ob ${sel('less')}" ${dis} onclick="_toggle('${enc}','less',${fid})"><small>less</small><b>${m.less.toFixed(2)}</b></button></div>`;
}

function drawSlip() {
  const n = S.slip.length;
  const odds = S.slip.reduce((a, l) => a * l.odds, 1);
  const html = !n ? `<h4>slip <span class="muted">0</span></h4><p class="muted tiny">Tap more or less on any player to add them.</p>` : `
    <h4>slip <span class="muted">${n} pick${n > 1 ? 's' : ''}</span></h4>
    ${S.slip.map(l => `<div class="sl"><div><b>${esc(l.name)}</b><br><span class="muted">${l.side} ${l.line} ${statWord(l.stat, 2)}</span></div>
      <div style="text-align:right"><b>${l.odds.toFixed(2)}</b><br><span class="x" onclick="_rm(${l.playerId})">remove</span></div></div>`).join('')}
    <div class="tot"><span class="muted">${n > 1 ? n + '-pick slip odds' : 'odds'}</span><b>${odds.toFixed(2)}</b></div>
    <input id="stake" type="number" min="10" value="${S.stake}">
    <div class="quick">${[25, 50, 100, 250].map(v => `<button onclick="_stake(${v})">${v}</button>`).join('')}</div>
    <div class="tot"><span class="muted">returns</span><b class="green">🪙 ${fmt(Math.round(S.stake * odds))}</b></div>
    <button class="btn grad" style="width:100%" onclick="_place()">place ${n > 1 ? 'slip' : 'pick'}</button>
    <p class="tiny muted" style="margin-top:8px">Daily limit left: ${fmt(Math.max(0, S.me.dailyLimit - S.me.stakedToday))} points</p>`;
  $('slip').innerHTML = html; $('slip2').innerHTML = html;
  ['slip', 'slip2'].forEach(id => { const i = $(id).querySelector('#stake'); if (i) i.oninput = e => { S.stake = parseInt(e.target.value, 10) || 0; drawSlip(); setTimeout(() => { const k = $(id).querySelector('#stake'); k.focus(); k.setSelectionRange(99, 99); }, 0); }; });
  $('slip-count').textContent = n;
  $('slip-fab').classList.toggle('hidden', !(S.page === 'card' || S.page === 'player') || !n);
}
window._rm = pid => { S.slip = S.slip.filter(x => x.playerId !== pid); drawSlip(); render(); };
window._stake = v => { S.stake = v; drawSlip(); };
$('slip-fab').onclick = () => document.querySelectorAll('.slip-wrap').forEach(w => w.classList.toggle('open'));

window._place = async () => {
  try {
    const r = await api('/bets', { method: 'POST', body: { stake: S.stake, legs: S.slip } });
    S.slip = []; S.me = r.me; await loadMe(); drawSlip(); confetti(); toast('Locked in. Good luck 🔥');
    document.querySelectorAll('.slip-wrap').forEach(w => w.classList.remove('open')); render();
  } catch (e) {
    if (e.status === 409 && e.data.moved) {
      e.data.moved.forEach(m => { const l = inSlip(m.playerId); if (l) l.odds = m.odds; });
      drawSlip(); toast('Odds moved. New prices are in your slip, tap place again.');
    } else toast(e.message);
  }
};

// ---------- pages ----------
function marketRow(m, fid, extra = '') {
  return `<div class="prow"><div class="who" onclick="openPlayer(${m.playerId})" style="cursor:pointer"><b>${esc(m.name)}</b>
    <span>${esc(m.team)} · ${m.stat} · avg ${m.avg}${extra}</span></div>
    <div class="line">${m.line}<small>${m.stat}</small></div>${oddsBtns(m, fid)}</div>`;
}

function scoreLine(f) {
  return f.status === 'NS' ? `kicks off ${time(f.kickoff)}` : f.status === 'LIVE' ? `<span class="live-dot"></span>${f.minute}'` : f.status;
}

async function rToday() {
  const fx = await api('/fixtures');
  const bets = await api('/bets');
  const all = fx.live.concat(fx.next);
  if (!all.length) {
    $('today-hero').innerHTML = `<div class="hero"><h1>no matches right now</h1><p class="muted">Live markets open when real games are on. Check back at kick-off.</p></div>`;
    ['today-picks', 'today-feed', 'today-players', 'today-others'].forEach(i => $(i).innerHTML = ''); return;
  }
  // Focus: match you picked, else your match with picks, else first live, else next
  const mine = bets.open.flatMap(b => b.legs);
  if (!S.focus || !all.find(f => f.id === S.focus)) {
    const withPick = fx.live.find(f => mine.some(l => l.fixture.id === f.id));
    S.focus = (withPick || fx.live[0] || fx.next[0]).id;
  }
  const d = await api('/fixture/' + S.focus);
  const f = d.fixture;
  $('today-hero').innerHTML = `<div class="hero"><div class="meta"><span>${esc(f.league)}</span><span>${scoreLine(f)}</span></div>
    <div class="score"><span>${esc(f.home)}</span><span class="n">${f.status === 'NS' ? 'vs' : f.homeGoals + ' - ' + f.awayGoals}</span><span>${esc(f.away)}</span></div>
    <div class="meta"><span>${esc(f.venue || '')}</span><span>${d.players.length} players priced</span></div></div>`;
  const legs = mine.filter(l => l.fixture.id === f.id);
  $('today-picks').innerHTML = legs.length ? legs.map(l => `<div class="glass pick"><div class="top-l"><b>${esc(l.player)}</b>
    <span>${l.side} ${l.line} · on <b>${l.soFar}</b></span></div><div class="bar"><i style="width:${Math.round(l.chance * 100)}%"></i></div>
    <div class="top-l tiny muted" style="margin-top:6px"><span>chance now ${Math.round(l.chance * 100)}%</span><span>@ ${l.odds.toFixed(2)}</span></div></div>`).join('')
    : `<div class="glass empty">No picks in this match yet. Tap a price on the right.</div>`;
  $('today-feed').innerHTML = d.events.length ? d.events.map(e => `<div class="${e.kind === 'goal' ? 'goal' : ''}"><span class="m">${e.minute}'</span>${esc(e.text)}</div>`).join('') : `<div class="muted">Feed starts at kick-off.</div>`;
  $('today-players').innerHTML = d.players.map(m => marketRow(m, f.id, ` · on ${m.soFar} · ${m.chanceMore}% more`)).join('') || `<div class="empty">No priced players yet.</div>`;
  $('today-others').innerHTML = all.filter(x => x.id !== f.id).slice(0, 8).map(x => `<div class="glass mini" onclick="focusMatch(${x.id})">
    <span><b>${esc(x.home)}</b> vs <b>${esc(x.away)}</b><br><span class="tiny muted">${esc(x.league)}</span></span>
    <span>${x.status === 'LIVE' ? x.homeGoals + '-' + x.awayGoals + ' · ' : ''}${scoreLine(x)}</span></div>`).join('');
}

async function rCard() {
  const lg = await api('/leagues');
  $('league-pills').innerHTML = `<span class="chip ${!S.league ? 'on' : ''}" onclick="_lg(0)">all</span>` +
    lg.map(l => `<span class="chip ${S.league === l.id ? 'on' : ''}" onclick="_lg(${l.id})">${esc(l.name)} <span class="muted">${l.open}</span></span>`).join('');
  const d = await api('/card' + (S.league ? '?league=' + S.league : ''));
  $('card-rows').innerHTML = d.rows.length ? d.rows.map(m => marketRow(m, m.fixture.id, ` · ${esc(m.fixture.home)} v ${esc(m.fixture.away)} · ${m.fixture.status === 'LIVE' ? m.fixture.minute + "' on " + m.soFar : time(m.fixture.kickoff)}`)).join('')
    : `<div class="empty">No open markets right now. They open when real fixtures are loaded.</div>`;
  drawSlip();
}
window._lg = id => { S.league = id || null; render(); };

async function rPlayer() {
  drawSlip();
  if (!S.playerId) { $('player-body').innerHTML = `<div class="glass empty">Search a player, or tap any name on the card.</div>`; return; }
  const p = await api('/player/' + S.playerId);
  const max = Math.max(1, ...p.form);
  $('player-body').innerHTML = `<div class="glass ph"><div class="row gap"><div class="avatar">${ini(p.name)}</div>
      <div><h1>${esc(p.name)}</h1><span class="muted">${esc(p.team)} · ${p.position === 'GK' ? 'keeper · saves' : 'outfield · shots'}</span></div></div>
      <div style="text-align:right"><b style="font-size:28px">${p.avg}</b><br><span class="muted tiny">${p.stat} a game · ${p.apps} apps</span></div></div>
    <h3 class="label">last ${p.form.length} matches</h3>
    <div class="glass chart">${p.form.map(v => `<div style="height:${v / max * 100}%"><span>${v}</span></div>`).join('') || '<span class="muted">No history yet</span>'}</div>
    ${p.fixture ? `<h3 class="label">${esc(p.fixture.home)} v ${esc(p.fixture.away)} · ${scoreLine(p.fixture)}</h3>
      <div class="glass list">${p.lines.map(m => `<div class="prow"><div class="who"><b>${m.line} ${p.stat}</b><span>${m.chanceMore}% chance of more · on ${m.soFar}</span></div><div></div>${oddsBtns(m, p.fixture.id)}</div>`).join('')}</div>
      <h3 class="label">same match</h3><div class="glass list">${p.sameMatch.map(m => marketRow(m, p.fixture.id)).join('')}</div>`
      : `<div class="glass empty" style="margin-top:16px">No upcoming match for ${esc(p.name)} right now.</div>`}`;
}
let sTimer;
$('search').oninput = e => { clearTimeout(sTimer); const q = e.target.value.trim();
  if (q.length < 2) return $('search-res').classList.add('hidden');
  sTimer = setTimeout(async () => { const r = await api('/search?q=' + encodeURIComponent(q));
    $('search-res').innerHTML = r.map(x => `<a onclick="_pick(${x.id})"><b>${esc(x.name)}</b> <span class="muted">${esc(x.team)}</span></a>`).join('') || '<a class="muted">No match</a>';
    $('search-res').classList.remove('hidden'); }, 200); };
window._pick = id => { $('search-res').classList.add('hidden'); $('search').value = ''; openPlayer(id); };

function betCard(b) {
  const open = b.status === 'open';
  return `<div class="glass pick"><div class="top-l"><span><b>${b.legs.length > 1 ? b.legs.length + '-pick slip' : 'single'}</b> · 🪙 ${fmt(b.stake)} @ ${b.odds.toFixed(2)}</span>
    <span class="status s-${b.status}">${b.status}</span></div>
    ${b.legs.map(l => `<div class="sl"><span>${esc(l.player)} <span class="muted">${l.side} ${l.line} ${statWord(l.stat, 2)} · ${esc(l.fixture.home)} v ${esc(l.fixture.away)}</span></span>
      <span>${l.status === 'open' ? 'on ' + l.soFar + ' · ' + Math.round(l.chance * 100) + '%' : `<span class="status s-${l.status}">${l.status}${l.result != null ? ' · ' + l.result : ''}</span>`}</span></div>`).join('')}
    <div class="top-l" style="margin-top:10px"><span class="muted">${open ? 'returns 🪙 ' + fmt(b.potential) : 'paid 🪙 ' + fmt(b.payout)}</span>
    ${open && b.cashout > 0 ? `<button class="btn green" style="padding:8px 14px" onclick="_cash(${b.id},${b.cashout})">cash out 🪙 ${fmt(b.cashout)}</button>` : ''}</div></div>`;
}
window._cash = async (id, v) => { if (!confirm(`Cash out for ${fmt(v)} points?`)) return;
  try { const r = await api(`/bets/${id}/cashout`, { method: 'POST' }); await loadMe(); confetti(); toast(`Cashed out 🪙 ${fmt(r.cashed)}`); render(); } catch (e) { toast(e.message); } };

async function rPortfolio() {
  const d = await api('/bets');
  $('pf-stats').innerHTML = [['points', '🪙 ' + fmt(S.me.points)], ['streak', '🔥 ' + S.me.streak + ' (best ' + S.me.bestStreak + ')'],
    ['win rate', d.stats.winRate + '%'], ['profit', `<span class="${d.stats.profit >= 0 ? 'green' : 'red'}">${d.stats.profit >= 0 ? '+' : ''}${fmt(d.stats.profit)}</span>`]]
    .map(([k, v]) => `<div class="glass tile"><span class="muted tiny">${k}</span><b>${v}</b></div>`).join('');
  $('pf-open').innerHTML = d.open.map(betCard).join('') || `<div class="glass empty">Nothing running. Go to more or less to make a pick.</div>`;
  $('pf-settled').innerHTML = d.settled.map(betCard).join('') || `<div class="glass empty">Settled bets show here.</div>`;
}

async function rLeagues() {
  const [lg, board] = await Promise.all([api('/leagues'), api('/leaderboard')]);
  $('lg-list').innerHTML = lg.map(l => `<div class="glass mini" onclick="_lg(${l.id});go('card')"><span><b style="color:${l.color}">●</b> <b>${esc(l.name)}</b> <span class="muted tiny">${esc(l.country || '')}</span></span><span class="muted">${l.open} open</span></div>`).join('') || `<div class="glass empty">Leagues appear once fixtures load.</div>`;
  const onBreak = S.me.breakUntil > Date.now();
  $('safe').innerHTML = `<p class="tiny muted">Daily limit: ${fmt(S.me.dailyLimit)} points · used today ${fmt(S.me.stakedToday)}</p>
    <div class="safe-row"><input id="lim" type="number" value="${S.me.dailyLimit}"><button class="btn ghost" onclick="_lim()">save</button></div>
    <p class="tiny muted">${onBreak ? 'On a break until ' + new Date(S.me.breakUntil).toLocaleString() : 'Take a break (no picks during it):'}</p>
    <div class="safe-row"><button class="btn ghost" onclick="_brk(24)">24 hours</button><button class="btn ghost" onclick="_brk(168)">7 days</button><button class="btn ghost" onclick="_brk(720)">30 days</button></div>
    ${S.me.canRefill ? `<button class="btn grad" onclick="_refill()">free refill +1,000</button>` : `<p class="tiny muted">Free refill of 1,000 unlocks once a day when you drop under 100 points.</p>`}`;
  $('board').innerHTML = board.map((u, i) => `<div class="prow"><div class="who"><b>${i + 1}. ${esc(u.username)}</b><span>🔥 ${u.streak} · best ${u.bestStreak}</span></div><div></div><b>🪙 ${fmt(u.points)}</b></div>`).join('');
}
window.go = go;
window._lim = async () => { try { S.me = await api('/limits', { method: 'POST', body: { dailyLimit: $('lim').value } }); toast('Limit saved'); render(); } catch (e) { toast(e.message); } };
window._brk = async h => { if (!confirm('Start a break? You cannot place picks until it ends.')) return; try { S.me = await api('/limits', { method: 'POST', body: { breakHours: h } }); toast('Break started'); render(); } catch (e) { toast(e.message); } };
window._refill = async () => { try { await api('/refill', { method: 'POST' }); await loadMe(); toast('+1,000 points'); render(); } catch (e) { toast(e.message); } };

// ---------- live updates ----------
let es, rTimer;
function stream() {
  if (es) es.close();
  es = new EventSource('/api/stream?token=' + S.token);
  es.onmessage = async ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'settled') {
      await loadMe();
      if (msg.status === 'won') { confetti(); toast(`Winner 🎉 +${fmt(msg.payout)} points. Streak ${msg.streak} 🔥`); }
      else if (msg.status === 'lost') toast('A bet lost. Streak reset.');
      else toast('A bet was voided, points returned.');
    }
    clearTimeout(rTimer); rTimer = setTimeout(() => { if (!document.activeElement || document.activeElement.id !== 'stake') render(); }, 400);
  };
  es.onerror = () => { es.close(); setTimeout(stream, 5000); };
}

async function boot() {
  if (!S.token) { $('auth').classList.remove('hidden'); return; }
  try { await loadMe(); } catch (e) { return; }
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  drawSlip(); go(S.page); stream();
}
boot();
