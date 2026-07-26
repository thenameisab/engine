<!--
  PUBLIC product changelog. This is a customer-facing document.

  It is deliberately NOT generated from the repo's CHANGELOG.md — that file is
  the engineering log, and it names packages, databases, hosting, API routes,
  migrations and PR numbers. None of that belongs on a page customers read.

  When you ship something, write the entry here in terms of what a customer can
  now do. Name capabilities, not components. The build refuses to publish if an
  internal term slips in — see BANNED in build-docs.mjs.
-->

## 2026-07-22 — Local visibility, measured and fixed

### New
- **Local visibility audit.** If you have physical locations, Engine now scores
  them: Business Profile completeness, whether your name, address and phone
  agree everywhere they appear, and the state of your reviews. You get one local
  score with the parts that made it kept visible, and it feeds your overall
  visibility score.
- **One-click Business Profile fixes.** The problems that audit finds can be
  fixed from Engine directly against your Google Business Profile — the same
  approve, apply, verify and undo flow as every other fix. A wrong phone number
  on three directories is now a queue item, not a to-do list.

---

## 2026-07-21 — Ask Engine a question, get a cited answer

### New
- **The Copilot is generally available.** Ask in plain language — "why did we
  lose visibility in Bangalore last month?" — and get an answer in under three
  seconds, with the evidence behind every claim and the ability to drill into
  any of it. Nothing is asserted without a source you can open.
- **Entity audit.** AI engines and Google's Knowledge Graph reason about
  *businesses*, not pages. Engine now checks whether yours is described
  consistently across the web, whether your site correctly identifies who you
  are, and whether your Knowledge Panel is right — then fixes the gaps.
- **Competitor intelligence.** See exactly where competitors beat you across
  both classic search and AI answers, in one comparison: keywords, citations,
  content, entities and links side by side.
- **Backlink and mention index.** Links matter, but for AI answers so do
  unlinked mentions of your brand. Engine tracks both, and shows which sources
  the answer engines actually draw from — so you get a ranked list of places
  worth earning a mention.

---

## 2026-07-20 — Content problems become content fixes

### New
- **Extractability scoring.** A page can rank and still never be quoted. Engine
  scores whether each page is written so an answer engine can lift a usable
  answer out of it, and checks it actually covers the topics it should.
- **Drafted rewrites.** Pages that score badly get a proposed rewrite you can
  read, edit, approve and apply — the diagnosis and the fix are the same
  workflow, not two products.
- **Titles and descriptions at scale.** Propose fixes for every page with a weak
  or missing title or description in one pass, rather than one at a time.
- **White-label for agencies.** Run multiple clients under one roof, invite your
  team, and put your own brand on the reports you send.

---

## 2026-07-19 — International alternates

### New
- **hreflang generation.** If you serve several countries or languages, Engine
  now generates and deploys the tags that tell search engines which version
  belongs to whom.

---

## 2026-07-18 — Fixes reach more places

### New
- **Send fixes as a pull request.** For teams who will not let anything write to
  production automatically, Engine can open a pull request against your own
  repository instead. Review it like any other change.
- **WordPress and Shopify plugins.** Apply fixes directly in your CMS.
- **Redirect and canonical repair.** Collapse redirect chains and resolve pages
  that disagree about their own canonical address.
- **Keyword and prompt research.** Decide what to track — classic keywords and
  the prompts people actually type into AI engines — including vernacular,
  Indic-script and transliterated queries.
- **Self-serve checkout.** Start a subscription without talking to us.

---

## 2026-07-17 — The audit gets real

### New
- **The audit view shows your actual site.** Findings from a real crawl,
  ordered by the difference fixing them is predicted to make, each one naming
  the problem and carrying the fix that resolves it.

### Fixed
- **Findings could not say what was wrong.** A stored finding kept its severity
  and its evidence but lost the statement of the problem itself, so the audit
  could tell you a page was badly broken without telling you how.

---

## 2026-07-16 — Sign in, and see live search data

### New
- **Accounts and sign-in**, so your work persists and your data is yours alone.
- **The SERP Inspector** shows live search results for any keyword you track —
  the first live external data in the product.

---

## 2026-07-15 — The Fix Queue

### New
- **Fixes deploy, verify themselves, and roll back.** The core loop: Engine
  finds a problem, proposes a specific change, applies it once you approve,
  checks that it actually landed, and undoes it automatically if it did not.
  Every step is recorded, so you can always see what was changed and why.
- **The dashboard.** Your visibility at a glance, and the queue of fixes waiting
  on you.

---

## 2026-07-14 — First light

### New
- **Visibility scoring across search and AI answers**, reported as an honest
  range rather than a single false-precise number.
- **The technical audit**, including whether AI crawlers are permitted to read
  your site at all — a question most audits never ask, and a surprising number
  of sites fail.
