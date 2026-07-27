/**
 * Builds the public documentation section at /docs.
 *
 * This is a CUSTOMER-FACING artifact. It describes what the product does, in
 * the customer's terms. It does not describe how the product is built.
 *
 * Nothing internal is published — not the architecture, not the stack, not the
 * repository layout, not competitive analysis, not the internal roadmap. That
 * rules out publishing the repo's own documents wholesale, so the public copy
 * is authored here and in apps/web/content/:
 *
 *   apps/web/content/changelog.md  -> /docs/changelog   (product changelog)
 *   COPY below                     -> /docs/features    (+ one page per feature)
 *   authored below                 -> /docs, /docs/roadmap
 *
 * Explicitly NOT sources: CHANGELOG.md (the engineering log — it names
 * packages, the database, hosting, API routes, migrations and PR numbers),
 * docs/00-Master-PRD.md, docs/10-Roadmap.md, docs/20-Architecture.md,
 * docs/30-Design-System.md, docs/40-Integrations.md,
 * docs/50-X0-Profound-Teardown.md, and the prose of docs/feature-specs/*.md.
 *
 * Only the pillar is read from the feature specs, so a new feature cannot go
 * missing from the index. Everything a reader sees is written here on purpose.
 *
 * The build FAILS if a term from BANNED reaches the output. Adding a feature
 * means writing its public copy — there is no path that leaks internals by
 * default.
 *
 * Run: pnpm --filter @engine/web build
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const WEB = dirname(fileURLToPath(import.meta.url));
const ROOT = join(WEB, '..', '..');
const OUT = join(WEB, 'docs');

/* ————————————————————————————————————————————————
   Availability, in customer terms. "Early access" rather than a component
   name or an internal blocker — a reader wants to know if they can use it,
   not which supplier contract or package is outstanding.
   ———————————————————————————————————————————————— */
const STATUS = {
  A1: 'early',
  A2: 'early',
  A3: 'available',
  A4: 'available',
  A5: 'available',
  A6: 'available',
  B1: 'available',
  B2: 'available',
  B3: 'available',
  B4: 'soon',
  B5: 'available',
};

const STATUS_LABEL = {
  available: 'Available',
  early: 'Early access',
  soon: 'Coming soon',
};

/* ————————————————————————————————————————————————
   Leak guard. If any of these reach the rendered pages the build fails.
   Covers the repository layout, the stack, internal contracts, supplier
   names and competitive analysis.
   ———————————————————————————————————————————————— */
const BANNED = [
  // repo + internals
  /\bpackages\//i, /\bapps\/(api|dashboard|web|workers)\b/i, /\bmigration\b/i,
  /\bPR #\d+/i, /\bmonorepo\b/i, /\bendpoint\b/i, /\b(GET|POST|PATCH|PUT|DELETE) \//,
  // stack + infrastructure
  /\bplaywright\b/i, /\bpostgres\b/i, /\bneon\b/i, /\bcloudflare\b/i, /\bwrangler\b/i,
  /\bjsonb\b/i, /\bJWKS\b/i, /\bJWT\b/i, /\bclickhouse\b/i, /\bqdrant\b/i,
  /\bvitest\b/i, /\bturborepo\b/i, /\bcloudflare workers\b/i, /\bschema\.org\b/i,
  // internal contract + architecture vocabulary. "Fix Queue" is deliberately
  // absent — it is a surface the customer sees by that name in the product.
  /Finding\s*(→|->)\s*Action/i, /\bentity-first\b/i,
  /\bedge-worker\b/i, /\bcms-plugin\b/i, /\bgithub-pr\b/i, /\bdeploy target\b/i,
  // suppliers (naming an answer engine we measure is fine; naming a vendor is not)
  /\bserper\b/i, /\bopenai\b/i, /\bstripe\b/i,
  // competitive analysis + internal strategy
  /\bprofound\b/i, /\bpeec\b/i, /\bahrefs\b/i, /\bsemrush\b/i,
  /\bmoat\b/i, /\bincumbent/i, /\bwedge\b/i, /\btable stakes\b/i, /\bteardown\b/i,
  /\bphase [123]\b/i,
];

/** Strip tags and entities so the guard reads what a visitor reads. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

const leaks = [];
function checkForLeaks(route, html) {
  const text = visibleText(html);
  for (const re of BANNED) {
    const hit = text.match(re);
    if (hit) leaks.push(`  /docs/${route} — "${hit[0]}" (${re})`);
  }
}

/* ————————————————————————————————————————————————
   Public copy. Authored here rather than lifted from the specs: the spec prose
   is written for us, and names competitors and internal strategy on nearly
   every feature. Write for someone deciding whether Engine solves their
   problem — capabilities and outcomes, never components.
   ———————————————————————————————————————————————— */
const COPY = {
  A1: {
    title: 'Rank Tracking',
    problem: `Knowing where you rank in Google — across every market, device and language you care about, and the moment it moves. Rank tracking is not the interesting part of Engine, and it is not meant to be: it is the search half of your visibility score, and one of the main things that sets off a diagnosis. It has to be correct and fast rather than clever.`,
    does: ['Daily rank positions by market, device and language', 'Movement that starts a diagnosis, not just an alert', 'Feeds the search half of your visibility score'],
  },
  A2: {
    title: 'AI Answer Visibility',
    problem: `Answer engines — ChatGPT, Perplexity, Gemini, Copilot, Google AI Overviews — increasingly decide what people discover. You need to know whether you appear in those answers, how accurately you are described, and how your share compares to everyone else. Engine reports this as a confidence band from repeated sampling, never as a single false-precise number, because one query to one model on one day is not a measurement.`,
    does: ['Asks the major answer engines your questions, repeatedly', 'Reports presence and share as a range, with the sampling behind it', 'Checks how accurately you are described, not just whether you appear', 'The strongest signal for what to fix next'],
  },
  A3: {
    title: 'Unified Visibility Score',
    problem: `Rank tracking, AI visibility and local each answer a fragment of one question: how discoverable are you? Your visibility score blends search, AI and local into a single measure, weighted by your own traffic mix rather than a generic average. One number, then depth — and the number carries its confidence range with it.`,
    does: ['One blended score across search, AI and local', 'Weighted by your actual traffic mix', 'A range, not a false-precise number', 'Drill from the score down to what moved it'],
  },
  A4: {
    title: 'Keyword & Prompt Research',
    problem: `Before you can track anything you have to decide what to track — both classic keywords and the prompts people actually type into AI engines. This is the on-ramp: it populates rank tracking and the prompt bank behind AI visibility. Prompts are treated as first-class research objects, and the research covers vernacular, Indic-script and transliterated queries rather than assuming English.`,
    does: ['Keyword research and AI prompt research in one place', 'Vernacular, Indic-script and transliterated coverage', 'Populates the tracked keyword set and the prompt bank directly'],
  },
  A5: {
    title: 'Competitor Intelligence',
    problem: `Visibility is relative — the useful question is where competitors beat you, and why. Engine compares search and AI answers together rather than in two separate reports, spanning keywords, citations, content and links at once. "They outrank us" and "they get cited and we do not" become two readings of the same comparison.`,
    does: ['Search and AI gaps in a single comparison', 'Keyword, citation, content and link gaps side by side', 'Every gap comes with the fix that closes it'],
  },
  A6: {
    title: 'Backlinks & Brand Mentions',
    problem: `For AI visibility, unlinked brand mentions carry more signal than backlinks — but most tooling indexes links and ignores mentions. Engine tracks both, and scores which domains the answer engines actually draw from, so you get a ranked list of places worth earning a mention rather than an undifferentiated backlink export.`,
    does: ['Backlinks and unlinked brand mentions in one index', 'Citation-domain intelligence: which sources the engines actually cite', 'Ranked, specific opportunities rather than a raw domain dump'],
  },
  B1: {
    title: 'Technical Audit',
    problem: `Engine reads your site the way a browser does, finds what is technically wrong, and — the part that matters — gives you problems that can actually be fixed rather than a list of warnings. Alongside the standard technical checks it asks whether AI crawlers like GPTBot, ClaudeBot and PerplexityBot are even permitted to read you at all. Most audits never ask, and a surprising number of sites are quietly blocking them.`,
    does: ['Reads your live site, rendered, the way a visitor sees it', 'Standard technical checks, ordered by the difference fixing them makes', 'Whether AI crawlers are allowed to read you', 'Every problem carries the fix that resolves it'],
  },
  B2: {
    title: 'Content & Extractability',
    problem: `Whether an AI engine quotes you depends largely on whether your page is easy to lift an answer out of: answers up front, passages that stand on their own, real coverage of the subject, credible signs of expertise. Engine scores that page by page — and then drafts the rewrite, rather than leaving you with a number and no next step.`,
    does: ['An extractability score for every page', 'Checks the page actually covers what it claims to be about', 'Low scorers become drafted rewrites you can review and approve'],
  },
  B3: {
    title: 'Entity & Knowledge Graph',
    problem: `AI engines and Google's Knowledge Graph reason about businesses, not pages. Engine checks whether yours is described consistently everywhere it appears, whether your own site correctly identifies who you are, and whether your Knowledge Panel is accurate — then fixes the gaps. It is what lets search and AI be one picture instead of two.`,
    does: ['Checks your business is described consistently across the web', 'Verifies your own site identifies you correctly', 'Knowledge Panel presence and accuracy', 'A single strength score for how well the web agrees about you'],
  },
  B4: {
    title: 'Crawl Analysis',
    problem: `Large sites need to know how crawlers — including AI bots — actually spend their time, and which pages are never reached at all. This is a long-standing capability for big sites; the addition here is treating AI bot traffic as a first-class part of it.`,
    does: ['See how crawl attention is actually spent across your site', 'AI bot traffic broken out separately', 'Find pages that are never reached at all'],
  },
  B5: {
    title: 'Local Visibility',
    problem: `For anything with a physical presence, local visibility is not a side report — it is a large share of how you are found. Engine checks your Google Business Profile, whether your name, address and phone agree everywhere they appear, and the state of your reviews, then folds local into your overall visibility score. Findings can be fixed on your Business Profile directly.`,
    does: ['Google Business Profile completeness and accuracy', 'Whether your name, address and phone agree everywhere', 'Review health as a scored input', 'Fixes applied to your Business Profile in one step'],
  },
};

/* ————————————————————————————————————————————————
   Page shell
   ———————————————————————————————————————————————— */

const NAV = [
  ['/docs', 'Overview'],
  ['/docs/architecture', 'Architecture'],
  ['/docs/features', 'Features'],
  ['/docs/changelog', 'Changelog'],
  ['/docs/roadmap', 'Roadmap'],
];

/** Depth-aware relative root so the pages also work from `file://`. */
function shell({ title, description, active, body, depth = 1 }) {
  const up = '../'.repeat(depth);
  const nav = NAV.map(([href, label]) => {
    const to = up + href.replace(/^\/docs\/?/, '') || up;
    const isOn = href === active;
    return `<a class="doc-nav-link${isOn ? ' on' : ''}"${isOn ? ' aria-current="page"' : ''} href="${to || '.'}">${label}</a>`;
  }).join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)} — Engine docs</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:title" content="${esc(title)} — Engine docs" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:type" content="article" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${up}docs.css" />
  <script>
    /* Applied before paint so a dark-mode reader never sees a light flash. */
    (function () {
      try {
        var saved = localStorage.getItem('engine-theme');
        var dark = saved ? saved === 'dark'
          : window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      } catch (e) {}
    })();
  </script>
</head>
<body>
  <div class="progress" aria-hidden="true"></div>
  <div class="shell">
    <header class="doc-top">
      <a class="wordmark" href="${up}../">Engine<span class="dot"></span></a>
      <nav class="doc-nav" aria-label="Documentation">
        ${nav}
      </nav>
      <button class="toggle" id="theme" type="button" aria-label="Toggle color theme">
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8l1.8-1.8M18 6l1.8-1.8"/></svg>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5z"/></svg>
      </button>
    </header>

    <main class="doc-main">
${body}
    </main>

    <footer>
      <span>Engine — AI visibility, measured and fixed.</span>
      <span>© 2026 <span class="sep">·</span> Built for the answer engines.</span>
    </footer>
  </div>

  <script>
    (function () {
      var root = document.documentElement;
      var btn = document.getElementById('theme');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var dark = root.getAttribute('data-theme') === 'dark';
        root.setAttribute('data-theme', dark ? 'light' : 'dark');
        try { localStorage.setItem('engine-theme', dark ? 'light' : 'dark'); } catch (e) {}
      });
    })();
  </script>
</body>
</html>
`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function write(route, html) {
  checkForLeaks(route, html);
  const dir = join(OUT, route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  console.log('  /docs' + (route ? '/' + route : ''));
}

const md2html = (md) => marked.parse(md);

/* ————————————————————————————————————————————————
   Pages
   ———————————————————————————————————————————————— */

function buildChangelog() {
  const md = readFileSync(join(WEB, 'content', 'changelog.md'), 'utf8');
  write('changelog', shell({
    title: 'Changelog',
    description: "What's new in Engine, newest first — written in terms of what you can now do.",
    active: '/docs/changelog',
    depth: 1,
    body: `      <article class="prose">
        <p class="kicker">Changelog</p>
        <h1 class="doc-h1">What's new</h1>
        <p class="doc-lede">Newest first. Written in terms of what you can now
        do with Engine, not what we rearranged to get there.</p>
        <hr class="rule" />
${md2html(md)}
      </article>`,
  }));
}

function readSpecs() {
  const dir = join(ROOT, 'docs', 'feature-specs');
  return readdirSync(dir)
    .filter((f) => /^[AB]\d-.*\.md$/.test(f))
    .sort()
    .map((file) => {
      // Only the pillar is read from the spec — enough that a new feature
      // cannot silently go missing from this index. Titles are public copy:
      // the spec headings carry internal naming ("Unified Share of Voice
      // (Unified Visibility Score) · Reference Spec").
      const raw = readFileSync(join(dir, file), 'utf8');
      const id = file.slice(0, 2);
      const meta = raw.match(/^\*\*Pillar:\*\*\s*([AB])\s*·/m);
      const copy = COPY[id];
      if (!copy) throw new Error(`No public copy authored for ${id} (${file})`);
      return {
        id,
        // Drop the internal module code from the URL too — /docs/features/A1-…
        // publishes our taxonomy, not a name the reader knows.
        slug: file.replace(/^[AB]\d-/, '').replace(/\.md$/, ''),
        pillar: meta ? meta[1] : '?',
        status: STATUS[id] || 'soon',
        ...copy,
      };
    });
}

function buildFeatures(specs) {
  const pillars = {
    A: ['Visibility', 'Where you stand across search results and AI answers — as an honest range, never a false-precise number.'],
    B: ['Diagnosis', 'What is holding you back, and the specific change that resolves it.'],
  };

  const groups = Object.entries(pillars).map(([key, [name, blurb]]) => {
    const cards = specs.filter((s) => s.pillar === key).map((s) => `
          <a class="feature-card" href="${s.slug}/">
            <div class="feature-card-top">
              <h3>${esc(s.title)}</h3>
              <span class="badge badge-${s.status}">${STATUS_LABEL[s.status]}</span>
            </div>
            <p>${esc(firstSentence(s.problem))}</p>
          </a>`).join('');
    return `
        <section class="pillar">
          <h2 class="pillar-h">${name}</h2>
          <p class="pillar-blurb">${blurb}</p>
          <div class="feature-grid">${cards}
          </div>
        </section>`;
  }).join('');

  write('features', shell({
    title: 'Features',
    description: 'Everything Engine does across visibility and diagnosis — what each part is for, and whether you can use it today.',
    active: '/docs/features',
    depth: 1,
    body: `      <div class="prose">
        <p class="kicker">Features</p>
        <h1 class="doc-h1">What Engine does</h1>
        <p class="doc-lede">Two halves. Measurement exists to feed diagnosis, and
        every diagnosis is written so it can become a change you actually ship —
        never a report that leaves the work to you.</p>
      </div>
${groups}`,
  }));

  for (const s of specs) {
    write(join('features', s.slug), shell({
      title: s.title,
      description: firstSentence(s.problem),
      active: '/docs/features',
      depth: 2,
      body: `      <article class="prose">
        <a class="back" href="../">← All features</a>
        <p class="kicker">${s.pillar === 'A' ? 'Visibility' : 'Diagnosis'}</p>
        <h1 class="doc-h1">${esc(s.title)}</h1>
        <div class="pill-row">
          <span class="badge badge-${s.status}">${STATUS_LABEL[s.status]}</span>
        </div>
        <hr class="rule" />
        <p class="doc-lede">${esc(s.problem)}</p>
        <h2>What it does</h2>
        <ul>
${s.does.map((d) => `          <li>${esc(d)}</li>`).join('\n')}
        </ul>
      </article>`,
    }));
  }
}

/* ————————————————————————————————————————————————
   Architecture — a conceptual, customer-facing view of how the pieces
   connect (measure -> score -> diagnose -> fix -> where it lands). This is
   deliberately NOT the technical architecture: no stack, no infra, no repo
   layout — the leak guard above still runs on this page like every other.
   ———————————————————————————————————————————————— */
function buildArchitecture(specs) {
  const byId = Object.fromEntries(specs.map((s) => [s.id, s]));
  const sources = ['A1', 'A2', 'A4', 'A5', 'A6'].map((id) => byId[id]);
  const score = byId.A3;
  const diagnose = ['B1', 'B2', 'B3', 'B4', 'B5'].map((id) => byId[id]);

  const archNode = (s, extra = '') => `
          <li class="arch-node">
            <button class="arch-node-btn" aria-expanded="false" aria-controls="arch-detail-${s.id}">
              <span class="arch-node-top">
                <span class="arch-node-name">${esc(s.title)}</span>
                <span class="badge badge-${s.status}">${STATUS_LABEL[s.status]}</span>
              </span>
              <p class="arch-node-teaser">${esc(firstSentence(s.problem))}</p>${extra}
              <span class="arch-node-foot">
                <span class="arch-node-cta">Details</span>
                <span class="arch-node-icon" aria-hidden="true"></span>
              </span>
            </button>
            <div class="arch-detail" id="arch-detail-${s.id}">
              <div class="arch-detail-inner">
                <p>${esc(s.problem)}</p>
                <a class="arch-detail-link" href="../features/${s.slug}/">See this feature →</a>
              </div>
            </div>
          </li>`;

  const connector = () => `
          <li class="arch-connector" aria-hidden="true">
            <span class="arch-connector-bar"></span>
            <span class="arch-connector-stem"></span>
            <span class="arch-connector-arrow"></span>
            <span class="arch-connector-dot"></span>
            <span class="arch-connector-dot arch-connector-dot--b"></span>
          </li>`;

  const rangeVisual = `
              <div class="arch-range" aria-hidden="true">
                <span class="arch-range-track"></span>
                <span class="arch-range-band"></span>
                <span class="arch-range-marker"></span>
              </div>`;

  const body = `      <div class="prose">
        <p class="kicker">Architecture</p>
        <h1 class="doc-h1">How the pieces connect</h1>
        <p class="doc-lede">Engine is one pipeline, not a pile of separate
        tools. Everything it measures feeds one score; everything that score
        cannot explain becomes a diagnosis; every diagnosis carries the fix
        that resolves it, applied and verified in place. Click any step for
        detail.</p>
      </div>

      <section class="arch" aria-label="How Engine's measurement, diagnosis and fix pipeline connects">
        <ol class="arch-flow">
          <li class="arch-stage" data-stage="measure">
            <div class="arch-stage-head">
              <span class="arch-stage-index">01</span>
              <h2 class="arch-stage-title">Measure</h2>
              <p class="arch-stage-blurb">Search, AI answers, competitors and
              the web's mentions of you — sampled repeatedly, never asked
              once.</p>
            </div>
            <ul class="arch-nodes">${sources.map((s) => archNode(s)).join('')}
            </ul>
          </li>
${connector()}
          <li class="arch-stage" data-stage="score">
            <div class="arch-stage-head">
              <span class="arch-stage-index">02</span>
              <h2 class="arch-stage-title">Score</h2>
              <p class="arch-stage-blurb">One blended number, weighted by your
              own traffic mix, reported as a range rather than a
              false-precise figure.</p>
            </div>
            <ul class="arch-nodes arch-nodes--single">${archNode(score, rangeVisual)}
            </ul>
          </li>
${connector()}
          <li class="arch-stage" data-stage="diagnose">
            <div class="arch-stage-head">
              <span class="arch-stage-index">03</span>
              <h2 class="arch-stage-title">Diagnose</h2>
              <p class="arch-stage-blurb">When the score moves, or on its own
              schedule, Engine checks why — technically, on the page, across
              the web, and locally.</p>
            </div>
            <ul class="arch-nodes">${diagnose.map((s) => archNode(s)).join('')}
            </ul>
          </li>
${connector()}
          <li class="arch-stage" data-stage="fix">
            <div class="arch-stage-head">
              <span class="arch-stage-index">04</span>
              <h2 class="arch-stage-title">Fix</h2>
              <p class="arch-stage-blurb">Every finding becomes a change you
              can approve — applied, checked, and reversed automatically if
              it does not land.</p>
            </div>
            <div class="arch-chain">
              <div class="arch-chain-step">
                <span class="arch-chain-num">1</span>
                <h3>Fix Queue</h3>
                <p>Every problem becomes a specific, reviewable change —
                never a report you are left to act on alone.</p>
              </div>
              <span class="arch-chain-arrow" aria-hidden="true">→</span>
              <div class="arch-chain-step">
                <span class="arch-chain-num">2</span>
                <h3>Apply</h3>
                <p>You approve it once. Engine makes the change directly, in
                your site, your CMS or your Business Profile.</p>
              </div>
              <span class="arch-chain-arrow" aria-hidden="true">→</span>
              <div class="arch-chain-step">
                <span class="arch-chain-num">3</span>
                <h3>Verify</h3>
                <p>Engine checks the fix actually landed — not just that it
                was sent.</p>
              </div>
              <span class="arch-chain-arrow" aria-hidden="true">→</span>
              <div class="arch-chain-branch">
                <div class="arch-chain-step arch-chain-step--good">
                  <span class="arch-chain-num">✓</span>
                  <h3>Landed</h3>
                  <p>Confirmed live, with a record of the change.</p>
                </div>
                <div class="arch-chain-step arch-chain-step--warn">
                  <span class="arch-chain-num">↺</span>
                  <h3>Rolled back</h3>
                  <p>If it does not land clean, Engine reverses it — no
                  manual cleanup.</p>
                </div>
              </div>
            </div>
          </li>
${connector()}
          <li class="arch-stage" data-stage="destination">
            <div class="arch-stage-head">
              <span class="arch-stage-index">05</span>
              <h2 class="arch-stage-title">Where it lands</h2>
              <p class="arch-stage-blurb">No new place to manage. Changes
              land where you already work.</p>
            </div>
            <p class="arch-dest-note">Every applied fix goes straight to the
            surface it belongs on:</p>
            <div class="arch-dest-row">
              <span class="pill">Your site</span>
              <span class="pill">Your CMS</span>
              <span class="pill">Your Business Profile</span>
            </div>
          </li>
        </ol>
      </section>

      <script>
      (function () {
        var root = document.documentElement;
        root.classList.add('js-arch');

        var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add('in-view');
              io.unobserve(entry.target);
            }
          });
        }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' }) : null;

        document.querySelectorAll('.arch-stage, .arch-connector').forEach(function (el) {
          if (io) io.observe(el); else el.classList.add('in-view');
        });

        document.querySelectorAll('.arch-node-btn').forEach(function (btn) {
          var detail = document.getElementById(btn.getAttribute('aria-controls'));
          if (!detail) return;
          detail.setAttribute('inert', '');
          btn.addEventListener('click', function () {
            var open = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!open));
            detail.classList.toggle('is-open', !open);
            if (open) detail.setAttribute('inert', '');
            else detail.removeAttribute('inert');
          });
        });
      })();
      </script>`;

  write('architecture', shell({
    title: 'Architecture',
    description: "How Engine's measurement, scoring, diagnosis and fix pipeline connects — from what it reads to what it changes and where.",
    active: '/docs/architecture',
    depth: 1,
    body,
  }));
}

function firstSentence(md) {
  const plain = md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links -> their text
    .replace(/[*_]{1,3}(?=\S)([^*_]+)(?<=\S)[*_]{1,3}/g, '$1')  // bold / italic
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = plain.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : plain).slice(0, 220);
}

const ROADMAP_MD = `
What you can use today, what we are working on, and what is further out. Dates
are deliberately absent — we would rather tell you what is true than commit to
a quarter.

## Available today

Visibility scoring across search and AI answers, reported as a range. The
technical audit, including whether AI crawlers can read you. Content
extractability and drafted rewrites. Entity checks against how the web
describes you. Competitor comparison. Links and brand mentions. Local
visibility. And the fixes for all of it — reviewed by you, applied by Engine,
verified afterwards, undone automatically if they do not land.

## In progress

Broader live coverage of the answer engines, and deeper history behind every
number so trends get more useful the longer you run it. Self-serve signup is
being opened up gradually — Engine is in private beta today.

## Further out

Crawl analysis for very large sites, more answer engines as they matter, and
the controls larger teams need: approvals, roles, and reporting across many
sites at once.

## What we are not building

A better report. Plenty of tools will tell you what is wrong with your site;
the hard part, and the only part worth our time, is making the change and
being able to take it back.
`;

function buildRoadmap() {
  write('roadmap', shell({
    title: 'Roadmap',
    description: 'What you can use today, what is in progress, and what we have deliberately chosen not to build.',
    active: '/docs/roadmap',
    depth: 1,
    body: `      <article class="prose">
        <p class="kicker">Roadmap</p>
        <h1 class="doc-h1">Where this is going</h1>
${md2html(ROADMAP_MD)}
      </article>`,
  }));
}

function buildIndex(specs) {
  const available = specs.filter((s) => s.status === 'available').length;
  write('', shell({
    title: 'Documentation',
    description: 'Engine documentation — how the product works, what is new, and where it is going.',
    active: '/docs',
    depth: 1,
    body: `      <div class="prose">
        <p class="kicker">Documentation</p>
        <h1 class="doc-h1">Engine, documented</h1>
        <p class="doc-lede">Engine measures how visible you are across AI answers
        and search — as an honest range, never a false-precise score — then makes
        the changes that move it, in your own site, CMS or Business Profile.</p>
      </div>

      <div class="card-grid">
        <a class="card" href="features/">
          <h3>Features →</h3>
          <p>Everything Engine does across measurement and diagnosis, and whether
          you can use it today.</p>
          <span class="card-meta">${available} available now</span>
        </a>
        <a class="card" href="changelog/">
          <h3>What's new →</h3>
          <p>Newest first, written in terms of what you can now do.</p>
          <span class="card-meta">Updated continuously</span>
        </a>
        <a class="card" href="roadmap/">
          <h3>Roadmap →</h3>
          <p>What is available today, what is in progress, and what we have
          chosen not to build.</p>
          <span class="card-meta">Private beta</span>
        </a>
      </div>

      <section class="prose principles">
        <hr class="rule" />
        <h2>How Engine works</h2>
        <p><b>It measures honestly.</b> Ask one AI engine one question on one day
        and you have an anecdote, not a measurement. Engine samples repeatedly
        and reports a range, so you can see how certain the number actually is.
        A confident answer and a shaky one never look the same.</p>
        <p><b>It treats you as a business, not a list of pages.</b> AI engines and
        Google's Knowledge Graph reason about who you are. So "how do we rank"
        and "who gets cited" are two views of one picture, rather than two tools
        you have to reconcile yourself.</p>
        <p><b>It finishes the job.</b> Every problem Engine reports comes with the
        specific change that resolves it. You approve it, Engine applies it,
        checks that it landed, and takes it back automatically if it did not —
        with a record of everything that changed.</p>
      </section>`,
  }));
}

/* ————————————————————————————————————————————————
   Build
   ———————————————————————————————————————————————— */

console.log('Building /docs …');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'docs.css'), readFileSync(join(WEB, 'docs.css'), 'utf8'));

const specs = readSpecs();
buildIndex(specs);
buildArchitecture(specs);
buildFeatures(specs);
buildChangelog();
buildRoadmap();

if (leaks.length) {
  console.error(
    `\nRefusing to publish — ${leaks.length} internal term(s) reached the public docs:\n` +
    leaks.join('\n') +
    `\n\n/docs is customer-facing. Describe the capability, not the implementation.\n` +
    `If a term is genuinely part of the product's own vocabulary, remove it from\n` +
    `BANNED in build-docs.mjs deliberately — do not work around this check.\n`
  );
  rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}

console.log(`Done — ${specs.length} feature pages, no internal terms published.`);
