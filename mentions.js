// mentions.js
// Parses @mentions in a post or comment and notifies the right people:
//   @username  -> notifies that specific member (and the text links to their profile)
//   @friends   -> notifies the author's accepted friends
//   @everyone  -> notifies the author's accepted friends AND their followers
//
// PRIVACY: a mention never reveals a post to someone who cannot see it. On a non-public
// post (friends-only, or a private community/group) the only people notified are those
// who can actually view it (the author's accepted friends); followers are NOT fanned out
// and an @named stranger is skipped, so a hidden post's existence is never advertised.
//
// ABUSE: recipients are deduped, the author is never self-notified, a block (either
// direction) is honored, each recipient's "who can @mention me" preference is honored,
// and three volume limits apply: a single post is capped (MAX_NOTIFY), a rolling
// per-actor hourly budget bounds one account's fan-out across many posts, and a durable
// per-RECIPIENT hourly cap bounds how many mention bells one person can receive (so many
// throwaway accounts each @mentioning the same victim once cannot flood them). The
// recipient cap is derived from the notifications table, so it survives restarts and is
// shared across instances (unlike the in-memory per-actor budget).
// Best-effort and fire-and-forget: a hiccup never breaks creating the post.

const db = require('./db');
const { notify } = require('./notify');

// A mention is @ + a valid username (letter then 3..20 letters/digits/underscore),
// matched only at a word boundary so emails (a@b) and URLs (x.com/@u) do not trigger.
const MENTION_RE = /(^|[^\w/@])@([a-zA-Z]\w{2,19})(?!\w)/g;

// Cap the people one post/comment can notify (explicit @names + @friends/@everyone
// fan-out combined). Override with MENTION_NOTIFY_MAX.
const MAX_NOTIFY = Number(process.env.MENTION_NOTIFY_MAX) > 0 ? Number(process.env.MENTION_NOTIFY_MAX) : 100;

// Rolling per-actor hourly budget so one account cannot mention-blast across many posts.
// In-memory (single instance), like the login throttle; move to Redis before scaling out.
const HOURLY_MAX = Number(process.env.MENTION_HOURLY_MAX) > 0 ? Number(process.env.MENTION_HOURLY_MAX) : 300;

// Durable per-RECIPIENT hourly cap: the most mention notifications one person can receive
// in a rolling hour, ACROSS all authors. Bounds a Sybil flood (many fresh accounts each
// @mentioning the same victim once), which the per-actor budget cannot catch. Derived
// from the notifications table so it is shared across instances and survives restarts.
const RECIPIENT_HOURLY_MAX = Number(process.env.MENTION_RECIPIENT_HOURLY_MAX) > 0 ? Number(process.env.MENTION_RECIPIENT_HOURLY_MAX) : 25;
const HOUR_MS = 60 * 60 * 1000;
const actorBudget = new Map(); // actorId -> { start, count }
function budgetRemaining(actorId) {
  const now = Date.now();
  let b = actorBudget.get(actorId);
  if (!b || (now - b.start) >= HOUR_MS) { b = { start: now, count: 0 }; actorBudget.set(actorId, b); }
  return Math.max(0, HOURLY_MAX - b.count);
}
function spendBudget(actorId, n) {
  const b = actorBudget.get(actorId) || { start: Date.now(), count: 0 };
  b.count += n; actorBudget.set(actorId, b);
}

// Pull the distinct lowercased @names + the @friends / @everyone flags out of text.
function parseMentions(text) {
  const out = { names: [], friends: false, everyone: false };
  if (!text) return out;
  const seen = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    const name = m[2].toLowerCase();
    if (name === 'friends') out.friends = true;
    else if (name === 'everyone') out.everyone = true;
    else if (!seen.has(name)) { seen.add(name); out.names.push(name); }
  }
  return out;
}

// Resolve mentions to a deduped, visibility-safe recipient set, then notify each
// (type 'mention'). opts.audience is the post's audience: 'public' (default) means the
// post is world-visible; anything else ('friends', or a private community/group) means
// only people who can see it (the author's friends) may be notified.
async function processMentions(authorId, text, postId, opts) {
  try {
    const parsed = parseMentions(text);
    if (!parsed.names.length && !parsed.friends && !parsed.everyone) return 0;
    const isPublic = !opts || opts.audience === undefined || opts.audience === 'public';

    // The author's accepted friends: used for @friends/@everyone, to restrict recipients
    // on a non-public post to people who can see it, and to honor a recipient's
    // "friends only" mention preference (friendship is mutual, so author-is-my-friend
    // equals recipient-is-author's-friend).
    const friendIds = new Set();
    {
      const friends = await db.prepare(
        "SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS uid " +
        "FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)"
      ).all(authorId, authorId, authorId);
      friends.forEach((r) => friendIds.add(r.uid));
    }

    const recipients = new Set();

    if (parsed.names.length) {
      const names = parsed.names.slice(0, MAX_NOTIFY);
      const ph = names.map(() => '?').join(',');
      const rows = await db.prepare('SELECT id FROM users WHERE lower(username) IN (' + ph + ')').all(...names);
      // On a non-public post, only notify a named user who can see it (a friend), so an
      // @named stranger is never told a hidden post exists.
      rows.forEach((r) => { if (isPublic || friendIds.has(r.id)) recipients.add(r.id); });
    }

    if (parsed.friends || parsed.everyone) friendIds.forEach((uid) => recipients.add(uid));

    // @everyone reaches followers ONLY on a public post (a follower may not be able to
    // see a friends-only post, so notifying them would leak its existence).
    if (parsed.everyone && isPublic) {
      const followers = await db.prepare('SELECT follower_id AS uid FROM follows WHERE followee_id = ?').all(authorId);
      followers.forEach((r) => recipients.add(r.uid));
    }

    recipients.delete(authorId); // never notify yourself

    // Safety: never notify across a block (either direction).
    if (recipients.size) {
      const blocked = await db.prepare(
        'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?'
      ).all(authorId, authorId);
      blocked.forEach((r) => recipients.delete(r.id));
    }
    // Honor each recipient's "who can @mention me" preference (all / friends / none).
    if (recipients.size) {
      const rids = [...recipients];
      const ph = rids.map(() => '?').join(',');
      const prefs = await db.prepare('SELECT id, mention_pref FROM users WHERE id IN (' + ph + ')').all(...rids);
      prefs.forEach((u) => {
        const pref = u.mention_pref || 'all';
        if (pref === 'none' || (pref === 'friends' && !friendIds.has(u.id))) recipients.delete(u.id);
      });
    }

    // Durable per-recipient hourly cap: drop anyone who has already received their inbound
    // mention ceiling in the last hour (counted across ALL authors from the notifications
    // table), so a ring of throwaway accounts cannot flood one victim with one @ each.
    if (recipients.size) {
      const rids = [...recipients];
      const ph = rids.map(() => '?').join(',');
      const counts = await db.prepare(
        "SELECT user_id AS uid, COUNT(*) AS c FROM notifications WHERE type = 'mention' " +
        "AND created_at >= datetime('now','-1 hour') AND user_id IN (" + ph + ') GROUP BY user_id'
      ).all(...rids);
      counts.forEach((r) => { if (r.c >= RECIPIENT_HOURLY_MAX) recipients.delete(r.uid); });
    }

    if (!recipients.size) return 0;

    const budget = budgetRemaining(authorId);
    if (budget <= 0) return 0;
    let count = 0;
    for (const uid of recipients) {
      if (count >= MAX_NOTIFY || count >= budget) break;
      try { await notify(uid, authorId, 'mention', postId || null); count++; } catch (e) { /* keep going */ }
    }
    spendBudget(authorId, count);
    return count;
  } catch (e) { return 0; }
}

module.exports = { parseMentions, processMentions, MAX_NOTIFY };
