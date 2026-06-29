# OpenBook Rules: ranking, reputation, and moderation

OpenBook is built on **credible neutrality**: the rules that decide what gets
seen, whose reputation rises or falls, and what gets removed are public, plain,
and the same for everyone. A neutrality claim only means something if you can
check it, so this document spells out the rules and points at the exact code that
runs them. If the code and this page ever disagree, that is a bug worth reporting.

Nothing on this page can be bought. Money never changes ranking, karma, standing,
reach, votes, or moderation outcomes (see "What money does and does not do").

And one line is absolute: being open source and fully transparent never means
anything goes. OpenBook does not allow illegal activity, full stop (see Section 5).

Source of truth: [`ranking.js`](ranking.js), [`trust.js`](trust.js),
[`moderation.js`](moderation.js), [`antisybil.js`](antisybil.js),
[`illegal.js`](illegal.js), and the routes under [`routes/`](routes/). Every
number below is taken from those files.

---

## 1. Two separate scores

OpenBook keeps two scores that are deliberately kept apart, because mixing them is
how most platforms quietly punish unpopular opinions.

- **Karma** is a social score from up and down votes. It drives **ranking only**.
  It can go negative. It never hides your content and never lowers your standing.
- **Standing** is a safety score. It starts at **100**, rises with account age and
  clean behaviour, and falls **only on a confirmed rule violation**. Standing, not
  votes, drives how far your content reaches (the graduated shadowban).

So you can hold an unpopular view, collect a pile of downvotes, and still be seen,
as long as your standing is healthy. A spammer with positive karma still gets
caught, because standing is what falls. (`trust.js`)

---

## 2. How posts and comments are ranked

All ranking math is in [`ranking.js`](ranking.js). Votes drive ranking only;
nothing here changes anyone's standing or hides content.

### Posts

**Hot** (the default feed sort):

```
hot = log10(max(|up - down|, 1)) + sign(up - down) * t / 45000
```

where `t` grows as a post gets newer. A post with more net upvotes outranks a
fresher one; at the same score, the fresher post wins. The decay constant is
**45000 seconds** (about half a day of freshness is worth one order of magnitude
of votes, the long-standing Reddit default).

**New** sorts purely by time. **Top** sorts by net votes within a time window
(day = last 1 day, week = last 7 days, month = last 30 days, or all time).
**Controversial** = `volume * balance`, which is highest when a post has many
votes that are close to evenly split, and near zero when it is one-sided or
quiet.

### Comments

**Best** (the default comment sort) uses the lower bound of a **Wilson score**
confidence interval (95%, z = 1.96). It rewards a high upvote ratio backed by
enough votes to be confident, so a 9-of-10 comment beats a 40-of-60 one. New,
Top, and Controversial sorts are also available.

### Trust-weighted votes (anti-brigade)

A brand-new account's vote moves the ranking far less than an established, clean
account's vote. Each vote is weighted by the voter's trust level when it is cast:

| Trust level | TL0 | TL1 | TL2 | TL3 | TL4 |
|-------------|-----|-----|-----|-----|-----|
| Vote weight | 0.1 | 0.4 | 0.7 | 1.0 | 1.0 |

The **raw** score (one human, one vote) is what you see on a post; the
**weighted** tally is what the ranking uses. This neutralises vote rings and
brigades without banning anyone. (`ranking.js`, `TRUST_WEIGHTS`)

---

## 3. Reputation: standing, trust levels, and reach

All of this is in [`trust.js`](trust.js). Every change to karma or standing is
written to the `trust_events` table, so the trail is complete and appealable.

### Standing

- New accounts start at **100** (the baseline).
- Standing is clamped at **0** at the bottom; it has no upper clamp, so good
  behaviour can lift it above baseline.
- A **confirmed** moderator or jury removal lowers standing by **25 points**
  (`VIOLATION_PENALTY` in `moderation.js`). A reversal on appeal adds it back.
- Votes **never** change standing. Suspicion alone never changes standing.

### Trust levels (TL0 to TL3)

Privileges unlock with **account age plus clean standing**, never with money or
ID:

| Level | How you reach it |
|-------|------------------|
| TL0 | brand new, or standing below 50 (poor standing pins you at TL0) |
| TL1 | account age at least 1 day |
| TL2 | account age at least 7 days |
| TL3 | account age at least 30 days |

### Reach (the graduated shadowban)

Standing maps to a **reach multiplier** applied at ranking time only:

| Standing | Reach multiplier |
|----------|------------------|
| 50 and above | 1.0 (normal) |
| 10 to 49 | 0.5 (quarantined: downranked) |
| below 10 | 0.05 (floor: effectively shadowbanned) |

Floored authors are excluded from other people's feeds (they still see their own
posts, so there is no obvious tell), and quarantined authors are downranked under
every sort. The reach multiplier is the one thing kept private: even you cannot
read your own reach score, because a graduated shadowban has to be silent to work.
It is never sold, never tied to money, and only ever moves with standing. Like all
moderation, the events that lowered your standing are logged and appealable, so a
shadowban is never secret-forever. (`trust.js`, `routes/posts.js`)

---

## 4. Moderation

Power sits at the edges, with the least at the centre (`moderation.js`,
[`routes/moderation.js`](routes/moderation.js), [`jury.js`](jury.js)):

- **Post authors** moderate their own threads.
- **Community moderators** moderate their community.
- **Platform admins** handle only sitewide-illegal content and the few global
  rules. Minimal central censorship by design.

### Reports to auto-hide (karma-weighted)

Anyone can report a post, comment, or reel. To stop brigades, each report carries
a **weight** based on the reporter's standing and trust level, capped hard for new
or low-trust accounts so a swarm of fresh sockpuppets carries almost nothing:

| Reporter standing | Flag weight |
|-------------------|-------------|
| 150 and above | 2.0 |
| 100 to 149 | 1.0 |
| 50 to 99 | 0.3 |
| below 50 | 0.05 |

(Plus a cap of 0.25 for TL0 accounts and 0.6 for TL1 accounts.) One open report
per person per item, so re-reporting cannot inflate the total.

When the **summed weight** of open reports on an item reaches **3.0**
(`FLAG_AUTOHIDE_THRESHOLD`), the item is **auto-hidden pending review**. The exact
math is written to the public mod log, and **no standing is changed** by an
auto-hide, so flagging can hide-for-review but can never by itself destroy
someone's reputation.

### Community jury

An auto-hide convenes a **community jury**: an odd panel (5 seats, minimum 3) of
randomly chosen members with pristine standing (120+), trust level 2 or higher,
verified, and **excluding the author and everyone who flagged it**. Jurors are
anonymous and judge the **content blind** (they do not see who wrote it). They
have 72 hours; a **majority** settles it. A tie or no quorum defaults to **keep**
(content is never removed without a majority). A "remove" verdict is a confirmed
violation: the content is removed and the author takes the 25-point standing
penalty. A "keep" restores the content and dismisses the flags. The full case file
is published to the public mod log. (`jury.js`)

### Appeals

Any moderation action can be appealed. A reversed appeal actually undoes the
action: it restores the content and credits the standing back. (`routes/moderation.js`)

### Transparency

Every public moderation action across the whole platform is in a public log at
`/mod-log` (no login required): human removals, auto-hides with their math, jury
outcomes, bans, and account-deletion notices. "Nothing is hidden" is meant to be
checkable by anyone.

---

## 5. Illegal activity: the one hard line

OpenBook protects unpopular opinions. It does not protect crime. Those are not the
same thing, and keeping them apart is exactly what lets us defend the first one.

Everything else here is settled in the open: the ranking is published, moderation
is logged in public, and big changes go to a community vote. But being open source
and fully transparent is a promise about HOW we run the platform, not a loophole
that makes anything goes. **Illegal activity is not allowed on OpenBook, full
stop.** This is the one rule that is not up for a vote, cannot be appealed on
free-speech grounds, and is never treated as just an unpopular idea. It is handled
completely apart from the neutrality machinery above. (SPEC section 12,
[`illegal.js`](illegal.js))

It covers anything genuinely illegal under the law that applies to us, including
but not limited to:

- Child sexual abuse material, and any sexual content involving minors.
- Credible threats of violence, incitement to violence, and terrorism.
- Human trafficking and exploitation.
- Sharing someone's intimate images without their consent.
- Fraud, scams, and the sale of clearly illegal goods.
- Malware, and doxxing that puts a real person in danger.

The line is drawn at illegal **acts** and illegal **material**, never at ideas.
You can criticise a government, a company, a faith, or any of us, and argue for
views most people reject, and that stays protected. What is not protected is using
OpenBook to break the law or to harm real people.

### How it works

- **Hash-matching on upload.** Every uploaded image, video, or file is SHA-256
  hashed and checked against a blocklist **before** it is stored. A match is
  rejected outright and logged confidentially. The blocklist starts empty and
  grows whenever an admin confirms illegal content, so the exact bytes can never
  be uploaded again. (Real perceptual-hash feeds such as NCMEC/PhotoDNA/PDQ
  require a legal agreement and cannot ship in an open repo; the code leaves a
  clean seam to add one.)
- **Reporting.** A report marked **illegal** is hidden immediately, flagged
  urgent, and routed **only to platform admins**. It never goes to a community
  jury and never changes standing on its own.
- **Confirmation.** When a platform admin confirms it, the content is removed
  everywhere, its media hash is added to the blocklist, the author takes the
  standing penalty, and the public log gets only a **generic** entry ("illegal
  content (legal removal)") with no details, so a takedown is transparent without
  re-exposing the material.

### This is still transparent, and the line cuts both ways

Refusing to host illegal content does not make us a black box. We publish exactly
how it is handled (right here), every takedown is in the public mod log written
generically (because republishing or describing the material would re-expose
victims), and anyone who believes their content was lawful and removed in error
can appeal.

And we hold ourselves to the same line. We comply with valid legal obligations,
such as removing unlawful content and reporting what the law requires us to report,
while refusing to censor lawful speech just because someone powerful dislikes it. A
platform that knowingly hosted illegal content would be cut off by its providers
and shut down, taking every voice on it, including the dissenting ones we exist to
protect, down with it. Staying lawful is not the opposite of staying free. It is
what keeps OpenBook alive to be free at all.

---

## 6. Anti-sybil (one human, one voice)

Influence cannot be bought with fake accounts or bot farms. Layered, and the
golden rule is "downweight, do not block," so a real dissident is never caught by
a blunt filter (`antisybil.js`):

- **Proof-of-work** on signup makes mass account creation expensive.
- **Cloudflare Turnstile** (privacy-friendly CAPTCHA) and a silent honeypot on
  signup and login stop automated bots.
- **Disposable / throwaway email** domains are blocked.
- **Device and IP concentration** (many accounts from one machine or address) is
  **flagged for review**, never hard-blocked (VPN and Tor users are legitimate).
- **Trust-scaled rate limits** give new accounts gentle posting caps that relax
  with age, and a brand-new account **cannot downvote** (it can still upvote).
- A background **vote-ring detector** finds clusters of low-trust accounts created
  together that vote in lockstep, and applies only a small, capped, appealable
  standing nudge plus a flag, never an instant ban on suspicion.
- New accounts must **verify their email** before they can post, comment, or vote.

---

## 7. What money does and does not do

Supporting OpenBook keeps the lights on. It is the **only** thing payment touches,
and it is purely cosmetic and capacity:

**Supporting CAN give you:** a supporter badge, a profile accent colour and theme,
more storage, and larger uploads.

**Supporting can NEVER give you:** more karma, higher standing, more reach, a
louder vote, a place in the feed, lighter moderation, or any influence over the
rules. Payment code only ever sets a supporter tier and an expiry date; it touches
nothing in this document. Everyone, paid or not, is ranked, judged, and moderated
by the exact same rules. (`entitlements.js`, `routes/billing.js`)

---

## 8. Changing these rules

The rules live in the open so they can be argued with. Feature and policy changes
go through a public suggestion board and community vote (one human, one vote), and
every status change is written to a public ledger. If you think a rule here is
wrong, open an issue or a pull request, or raise it on the roadmap. The point of
publishing the rulebook is that it can be checked and challenged, not that it is
final.
