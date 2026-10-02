// Pricing: turns a player's average into fair odds, then takes a small house edge.
// Shots and saves follow a Poisson pattern, which is the standard way books price counts.

const MARGIN = 0.93;      // 7% edge, so prices look like a real book
const MATCH_MINUTES = 90;

// Chance a Poisson count with average `lam` is k or less
function cdf(k, lam) {
  if (k < 0) return 0;
  let term = Math.exp(-lam), sum = term;
  for (let i = 1; i <= k; i++) { term *= lam / i; sum += term; }
  return Math.min(1, sum);
}

// Expected count still to come, given the minute played
function remainingAverage(avg, minute) {
  const left = Math.max(0, MATCH_MINUTES - minute);
  return avg * left / MATCH_MINUTES;
}

// Chance the final count ends ABOVE the line
function chanceMore(line, avg, soFar = 0, minute = 0) {
  if (soFar > line) return 1;
  const lam = remainingAverage(avg, minute);
  const need = Math.floor(line - soFar); // need more than this many still to come
  return 1 - cdf(need, lam);
}

function toOdds(p) {
  if (p <= 0.0001) return 50;
  const o = MARGIN / p;
  return Math.max(1.01, Math.min(50, Math.round(o * 100) / 100));
}

// Price one line. Returns null when the line is already decided (no more betting on it).
function price(line, avg, soFar = 0, minute = 0) {
  const pMore = chanceMore(line, avg, soFar, minute);
  const pLess = 1 - pMore;
  const open = pMore > 0.03 && pMore < 0.97;
  return { line, pMore, pLess, more: toOdds(pMore), less: toOdds(pLess), open };
}

// The main line is the one closest to a 50/50 call before kick off
function mainLine(avg) {
  let best = 0.5, gap = 9;
  for (let l = 0.5; l <= 8.5; l += 1) {
    const g = Math.abs(chanceMore(l, avg) - 0.5);
    if (g < gap) { gap = g; best = l; }
  }
  return best;
}

// Every line we offer on a player: main line plus up to two either side
function allLines(avg) {
  const m = mainLine(avg);
  return [m - 2, m - 1, m, m + 1, m + 2].filter(l => l >= 0.5);
}

module.exports = { price, mainLine, allLines, chanceMore, toOdds, MARGIN };
