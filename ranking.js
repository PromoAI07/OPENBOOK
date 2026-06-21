// ranking.js
// Phase 2: the published, auditable ranking and reputation math (see SPEC.md
// sections 7 and 12). Credible neutrality is the whole product, so these rules
// live in the open repo as plain, documented functions, not a black box.
//
// The core OpenBook rule still holds: votes drive RANKING only. Nothing in this
// file touches a user's standing or hides content. Standing and the shadowban
// are handled by trust.js.
//
// Two ideas combine here:
//   1. Time-decayed "hot" ranking (Reddit-style) for posts.
//   2. Trust-weighted "effective" votes so a brand-new account moves the ranking
//      far less than an established, clean account. This neutralises vote rings
//      and brigades without banning anyone.

// Reference epoch (seconds). Ranking is RELATIVE, so this constant only shifts
// every hot score by the same amount and never changes the order. It exists so
// the time term stays a small, readable number. 2023-11-14T22:13:20Z.
const HOT_EPOCH = 1700000000;

// Decay constant from the SPEC. Larger = slower decay (score matters longer);
// 45000 seconds means roughly half a day of "freshness" is worth one order of
// magnitude of votes, which is Reddit's long-standing default.
const HOT_DECAY = 45000;

// Parse a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to epoch seconds.
function epochSeconds(ts) {
  if (!ts) return HOT_EPOCH;
  const iso = ts.indexOf('T') >= 0 ? ts : ts.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return isNaN(ms) ? HOT_EPOCH : Math.floor(ms / 1000);
}

// Post "hot" rank. Higher = ranks higher.
//   hot = log10(max(|up - down|, 1)) + sign(up - down) * t / HOT_DECAY
// where t grows as the post gets NEWER (t = created_seconds - HOT_EPOCH), so a
// fresh post outranks an old one at the same score, and a post with more net
// upvotes outranks a fresher one. up/down may be fractional (effective votes).
function hot(up, down, createdAt) {
  const s = up - down;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  const t = epochSeconds(createdAt) - HOT_EPOCH;
  return order + (sign * t) / HOT_DECAY;
}

// Comment "best" rank: the lower bound of a Wilson score confidence interval for
// a Bernoulli parameter. It rewards a high upvote RATIO with enough volume to be
// confident, so a 9/10 comment beats a 40/60 one. Returns a value in [0, 1].
// A comment with no votes scores 0 (sits below anything with net positive votes).
function wilson(up, down) {
  const n = up + down;
  if (n <= 0) return 0;
  const z = 1.96; // 95% confidence
  const phat = up / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return (centre - margin) / denom;
}

// "Controversial" rank: high when up and down are both large AND close to equal.
// Balanced, heavily-voted content scores highest; one-sided or low-volume scores
// near zero. Returns 0 unless there is at least one up and one down vote.
// volume * balance is monotonic in BOTH volume and balance at every scale,
// including the fractional trust-weighted inputs (effUp/effDown) which routinely
// total below 1 (a Math.pow(volume, balance) form inverts when volume < 1).
function controversy(up, down) {
  if (up <= 0 || down <= 0) return 0;
  const volume = up + down;
  const balance = up > down ? down / up : up / down; // in (0, 1]
  return volume * balance;
}

// Vote weight by Discourse-style trust level (TL0..TL4). A new account's vote is
// nearly weightless; an established, clean account's vote counts in full. This is
// the SPEC's anti-brigade lever: "vote weight scales with trust."
const TRUST_WEIGHTS = [0.1, 0.4, 0.7, 1.0, 1.0];
function trustWeight(trustLevel) {
  const tl = Math.max(0, Math.min(TRUST_WEIGHTS.length - 1, trustLevel | 0));
  return TRUST_WEIGHTS[tl];
}

// For a "Top" sort window, return the SQLite datetime() modifier (or null = all
// time). Used to filter posts to the last day / week before sorting by score.
function topWindowModifier(window) {
  if (window === 'day') return '-1 day';
  if (window === 'week') return '-7 days';
  if (window === 'month') return '-30 days';
  return null; // all
}

// The base ranking metric for a post under a given sort (higher = ranks higher),
// independent of reach. hot can be negative; the others are non-negative.
function baseMetric(p, sort) {
  if (sort === 'new') return epochSeconds(p.created_at);
  if (sort === 'top') return effNet(p);
  if (sort === 'controversial') return controversy(p.effUp, p.effDown);
  return hot(p.effUp, p.effDown, p.created_at); // default: hot
}

// Rank a list of already-decorated posts by the chosen sort. Each post is
// expected to carry: created_at, score (raw, shown to users), and effUp/effDown
// (trust-weighted tallies used for ranking). `reachOf` is an optional function
// (post -> multiplier in (0,1]) supplied ONLY by the home feed to apply the
// graduated-shadowban reach multiplier; it is never exposed on the post object.
// Returns a new sorted array; never mutates the caller's array order.
function rankPosts(posts, sort, window, reachOf) {
  const hasReach = typeof reachOf === 'function';
  let list = posts.slice();

  // Top's time window applies regardless of reach.
  if (sort === 'top') {
    const mod = topWindowModifier(window);
    if (mod) {
      const cutoff = epochSeconds(sqliteNowMinus(mod));
      list = list.filter((p) => epochSeconds(p.created_at) >= cutoff);
    }
  }

  if (!hasReach) {
    // Community listings: rank by the pure metric, stable tie-break by recency.
    list.sort((a, b) => (baseMetric(b, sort) - baseMetric(a, sort)) || cmpTime(b, a));
    return list;
  }

  // Home feed: apply reach to EVERY sort, not just hot. We shift each post's
  // base metric to a strictly-positive, set-relative key before multiplying by
  // reach, so a lower reach always lowers the final key (no sign inversion the
  // way a raw `hot * reach` had, where multiplying a negative hot by 0.05 moved
  // it toward zero and BOOSTED suppressed content). Quarantined authors are
  // downranked under hot/new/top alike; fully floored authors are excluded
  // upstream in the route before this runs.
  let minBase = Infinity;
  for (const p of list) { const b = baseMetric(p, sort); if (b < minBase) minBase = b; }
  if (!isFinite(minBase)) minBase = 0;
  list.sort((a, b) => {
    const ka = (baseMetric(a, sort) - minBase + 1) * reachOf(a);
    const kb = (baseMetric(b, sort) - minBase + 1) * reachOf(b);
    return kb === ka ? cmpTime(b, a) : kb - ka;
  });
  return list;
}

function effNet(p) { return (p.effUp || 0) - (p.effDown || 0); }
function cmpTime(a, b) {
  const ta = epochSeconds(a.created_at);
  const tb = epochSeconds(b.created_at);
  return ta === tb ? (a.id || 0) - (b.id || 0) : ta - tb;
}

// Compute a JS Date for "now minus modifier" without SQLite, so the window
// filter does not need a database round-trip. Modifier is like '-7 days'.
function sqliteNowMinus(mod) {
  const m = /^-(\d+)\s+(day|days|hour|hours)$/.exec(mod);
  const now = Date.now();
  if (!m) return new Date(now).toISOString();
  const n = Number(m[1]);
  const unit = m[2].indexOf('hour') === 0 ? 3600000 : 86400000;
  return new Date(now - n * unit).toISOString();
}

const SORTS = ['hot', 'new', 'top', 'controversial'];
const COMMENT_SORTS = ['best', 'new', 'top', 'controversial'];

module.exports = {
  HOT_EPOCH,
  HOT_DECAY,
  TRUST_WEIGHTS,
  SORTS,
  COMMENT_SORTS,
  epochSeconds,
  hot,
  wilson,
  controversy,
  trustWeight,
  topWindowModifier,
  rankPosts,
};
