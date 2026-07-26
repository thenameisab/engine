/**
 * Builds the public documentation section at /docs from the markdown that
 * already exists in the repo, so there is one source of truth.
 *
 *   CHANGELOG.md              -> /docs/changelog
 *   docs/feature-specs/*.md   -> /docs/features + /docs/features/<id>
 *   (authored below)          -> /docs, /docs/roadmap
 *
 * Deliberately NOT published: docs/00-Master-PRD.md, docs/10-Roadmap.md,
 * docs/50-X0-Profound-Teardown.md and the design/integration docs. They carry
 * competitive analysis, moat reasoning, team sizing and provisioning detail
 * that is internal. The feature specs are filtered too — only the title, the
 * pillar/phase line, the problem statement and the scope are lifted; "Moat
 * weight", PRD cross-references and the implementation sections are dropped.
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
   Shipped status. Drives the badge in the feature index; kept here rather
   than in the specs because the specs describe intent, not what is merged.
   ———————————————————————————————————————————————— */
const STATUS = {
  A1: ['partial', 'Scoring live; awaiting a SERP data provider for live ingestion'],
  A2: ['partial', 'Adapters live; awaiting per-engine LLM API access'],
  A3: ['shipped', 'Unified Visibility Score with confidence bands'],
  A4: ['shipped', 'MVP slice — packages/keywords'],
  A5: ['shipped', 'packages/competitor'],
  A6: ['shipped', 'packages/backlink'],
  B1: ['shipped', 'Rule engine + Playwright crawler'],
  B2: ['shipped', 'Extractability scorer v1 + entity coverage'],
  B3: ['shipped', 'packages/entity-audit'],
  B4: ['planned', 'Phase 3'],
  B5: ['shipped', 'packages/local'],
};

const STATUS_LABEL = { shipped: 'Shipped', partial: 'Partial', planned: 'Planned' };

/* ————————————————————————————————————————————————
   Public copy. Authored here rather than lifted from the specs: the spec
   prose is written for us, and names competitors, moat reasoning and wedge
   strategy on nearly every feature. Only the title, pillar and phase are read
   from the spec files, so the index cannot drift out of sync with them.
   ———————————————————————————————————————————————— */
const COPY = {
  A1: {
    problem: `Knowing where you rank in Google — across every market, device and language you care about, and the moment it moves. Rank tracking is not the interesting part of Engine, and it is not meant to be: it is the organic half of your Unified Visibility Score, and one of the main things that trips a diagnosis. It has to be correct, fast and cheap rather than clever.`,
    does: ['Daily rank positions by market, device and language', 'Movement detection that triggers a diagnosis, not just an alert', 'Feeds the organic half of the Unified Visibility Score'],
  },
  A2: {
    problem: `Answer engines — ChatGPT, Perplexity, Gemini, Copilot, Google AI Overviews — increasingly decide what people discover. You need to know whether you appear in those answers, how accurately you are described, and how your share compares to everyone else. Engine reports this as a confidence band from repeated sampling, never as a single false-precise number, because one query to one model on one day is not a measurement.`,
    does: ['Polls the major answer engines on your prompt set', 'Reports presence and share as a range, with the sampling behind it', 'Checks how accurately you are described, not just whether you appear', 'The highest-signal trigger into the Fix Queue'],
  },
  A3: {
    problem: `Rank tracking, AI visibility and local each answer a fragment of one question: how discoverable are you? The Unified Visibility Score blends organic, AI and local into a single measure, weighted by your own traffic mix rather than a generic average. One number, then depth — and the number carries its confidence band with it.`,
    does: ['One blended score across organic, AI and local', 'Weighted by your actual traffic mix', 'Confidence bands throughout — the range is the answer', 'Drill down from the score to the finding that moved it'],
  },
  A4: {
    problem: `Before you can track anything you have to decide what to track — both classic keywords and the prompts people actually type into AI engines. This is the on-ramp: it populates rank tracking and the prompt bank behind AI visibility. Prompts are treated as first-class research objects, and the research covers vernacular, Indic-script and transliterated queries rather than assuming English.`,
    does: ['Keyword research and AI prompt research in one place', 'Vernacular, Indic-script and transliterated coverage', 'Populates the tracked keyword set and the prompt bank directly'],
  },
  A5: {
    problem: `Visibility is relative — the useful question is where competitors beat you, and why. Because Engine holds one entity model rather than a separate SEO store and GEO store, the gap analysis spans keywords, citations, content, entities and backlinks at once. "They outrank us" and "they get cited and we do not" become two readings of the same comparison.`,
    does: ['Unified SEO + GEO gap analysis on one entity model', 'Keyword, citation, content, entity and backlink gaps side by side', 'Gaps become ranked, executable actions'],
  },
  A6: {
    problem: `For AI visibility, unlinked brand mentions carry more signal than backlinks — but most tooling indexes links and ignores mentions. Engine tracks both, and scores which domains the answer engines actually draw from, so you get a ranked list of places worth earning a mention rather than an undifferentiated backlink export.`,
    does: ['Backlinks and unlinked brand mentions in one index', 'Citation-domain intelligence: which sources the engines actually cite', 'Ranked, specific opportunities rather than a raw domain dump'],
  },
  B1: {
    problem: `Crawl the site, find what is technically wrong, and — the part that matters — emit findings that can actually be executed. Alongside standard technical SEO auditing it runs an AI-crawler access audit: whether GPTBot, ClaudeBot and PerplexityBot are even permitted to read you, which is a question classic auditors do not ask and a surprising number of sites fail.`,
    does: ['Playwright crawl of the live site', 'Standard technical SEO checks, scored by predicted impact', 'AI-crawler access audit (GPTBot, ClaudeBot, PerplexityBot)', 'Every finding carries the action that would fix it'],
  },
  B2: {
    problem: `Whether an AI engine cites you depends largely on whether your page is extractable: answer-first, self-contained passages, real entity coverage, credible expertise signals. B2 scores that, page by page, and hands the low scorers to the content rewrite executor rather than leaving you with a number and no next step.`,
    does: ['Extractability score per page', 'Entity and topic coverage checked against what the page should cover', 'Feeds AI-drafted rewrites through the normal Fix Queue'],
  },
  B3: {
    problem: `AI engines and Google's Knowledge Graph reason over entities, not URLs. B3 checks whether your entity is consistent, corroborated and correctly mapped across the web — Wikidata and sameAs consistency, on-site schema, Knowledge Panel status — and turns the gaps into schema and knowledge-graph fixes. This is the module that makes "SEO and GEO are one world" concrete rather than a slogan.`,
    does: ['Resolves your entity to a canonical ID and audits sameAs consistency', 'Verifies on-site schema identifies the entity correctly', 'Knowledge Panel presence and accuracy', 'A cross-web corroboration score, rolled into entity strength'],
  },
  B4: {
    problem: `Large sites need to know how crawlers — including AI bots — actually spend crawl budget, and which pages are never reached at all. Log-file analysis is a long-standing enterprise SEO capability; the addition here is treating AI bot traffic as a first-class dimension of it.`,
    does: ['Crawl budget analysis from raw server logs', 'AI bot traffic broken out separately', 'Orphaned and never-crawled page detection'],
  },
  B5: {
    problem: `For anything with a physical presence, local visibility is not a side report — it is a large share of how you are found. B5 audits Google Business Profile health, NAP consistency across citation sources, and review health, then feeds local share of voice into the Unified Visibility Score. It pairs directly with GBP automation, so a local finding is one click from being fixed.`,
    does: ['Google Business Profile completeness and accuracy', 'NAP consistency across citation sources', 'Review health as a scored input', 'Findings execute against the Business Profile API'],
  },
};

/* ————————————————————————————————————————————————
   Page shell
   ———————————————————————————————————————————————— */

const NAV = [
  ['/docs', 'Overview'],
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
  const dir = join(OUT, route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  console.log('  /docs' + (route ? '/' + route : ''));
}

/* ————————————————————————————————————————————————
   Markdown -> HTML
   ———————————————————————————————————————————————— */

/**
 * The repo is private, so PR links would 404 for a reader. Keep the reference
 * (it is useful provenance) and drop the dead href.
 */
function neutralizePrivateLinks(md) {
  return md
    .replace(/\[([^\]]*PR #\d+[^\]]*)\]\(https:\/\/github\.com\/[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:\.\.\/)*(?:docs\/)?[\w./-]+\.md(?:#[\w-]*)?\)/g, '$1');
}

/**
 * Drop bullets marked internal in the source. A bullet written as
 * `- <!--internal--> …` is kept in CHANGELOG.md but never published — the
 * repo's own history should stay complete while the public page omits
 * competitive analysis. Continuation lines (indented under the bullet) go too.
 */
function stripInternal(md) {
  const lines = md.split('\n');
  const out = [];
  let dropping = false;
  for (const line of lines) {
    if (/^\s*[-*]\s*<!--\s*internal\s*-->/.test(line)) { dropping = true; continue; }
    if (dropping) {
      // Continuations are indented; anything at column zero ends the bullet.
      if (/^\s+\S/.test(line) || line.trim() === '') continue;
      dropping = false;
      out.push('');  // the blank line we swallowed, so the next block still separates
    }
    out.push(line);
  }
  return out.join('\n');
}

function md2html(md) {
  return marked.parse(stripInternal(neutralizePrivateLinks(md)));
}

/* ————————————————————————————————————————————————
   Pages
   ———————————————————————————————————————————————— */

function buildChangelog() {
  const raw = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  // Drop the H1 and the file preamble — the page header already says all of
  // this, and the preamble points at internal docs. Content starts at the
  // first `---` rule.
  const md = raw.slice(raw.indexOf('\n---\n') + 5).trim();
  write('changelog', shell({
    title: 'Changelog',
    description: 'Everything shipped in Engine, newest first — what changed, what broke, and what it cost.',
    active: '/docs/changelog',
    depth: 1,
    body: `      <article class="prose">
        <p class="kicker">Changelog</p>
        <h1 class="doc-h1">Everything we shipped</h1>
        <p class="doc-lede">Newest first, grouped by day and theme. Written to be
        read — what changed, why it was wrong before, and what it now does.</p>
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
      const raw = readFileSync(join(dir, file), 'utf8');
      const id = file.slice(0, 2);
      const h1 = (raw.match(/^# (.+)$/m) || [, id])[1]
        .replace(/\s*·\s*Reference Spec\s*$/, '');
      const meta = raw.match(/^\*\*Pillar:\*\*\s*([AB])\s*·\s*\*\*Phase:\*\*\s*([^·]+)·/m);
      const [status, statusNote] = STATUS[id] || ['planned', ''];
      const copy = COPY[id];
      if (!copy) throw new Error(`No public copy authored for ${id} (${file})`);
      return {
        id,
        slug: file.replace(/\.md$/, ''),
        title: h1.replace(/^[AB]\d\s*—\s*/, ''),
        pillar: meta ? meta[1] : '?',
        phase: meta ? meta[2].trim() : '',
        status,
        statusNote,
        ...copy,
      };
    });
}

function buildFeatures(specs) {
  const pillars = {
    A: ['Pillar A — Visibility', 'Measure where you stand across search results and AI answers, as an honest range.'],
    B: ['Pillar B — Diagnosis', 'Find what is holding you back, and turn every finding into something executable.'],
  };

  const groups = Object.entries(pillars).map(([key, [name, blurb]]) => {
    const cards = specs.filter((s) => s.pillar === key).map((s) => `
          <a class="feature-card" href="${s.slug}/">
            <div class="feature-card-top">
              <span class="feature-id">${s.id}</span>
              <span class="badge badge-${s.status}">${STATUS_LABEL[s.status]}</span>
            </div>
            <h3>${esc(s.title)}</h3>
            <p>${esc(firstSentence(s.problem))}</p>
            <span class="feature-meta">${esc(s.phase)}${s.statusNote ? ' · ' + esc(s.statusNote) : ''}</span>
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
    description: 'Every Engine module across visibility and diagnosis — what it does, what is in scope, and whether it has shipped.',
    active: '/docs/features',
    depth: 1,
    body: `      <div class="prose">
        <p class="kicker">Features</p>
        <h1 class="doc-h1">What Engine does</h1>
        <p class="doc-lede">Engine is built in pillars. Everything in Visibility
        exists to feed Diagnosis, and every diagnosis is written to become an
        executable fix — that contract was frozen on day one.</p>
      </div>
${groups}`,
  }));

  for (const s of specs) {
    write(join('features', s.slug), shell({
      title: `${s.id} — ${s.title}`,
      description: firstSentence(s.problem),
      active: '/docs/features',
      depth: 2,
      body: `      <article class="prose">
        <a class="back" href="../">← All features</a>
        <p class="kicker">${s.id} · Pillar ${s.pillar}</p>
        <h1 class="doc-h1">${esc(s.title)}</h1>
        <div class="pill-row">
          <span class="badge badge-${s.status}">${STATUS_LABEL[s.status]}</span>
          <span class="pill">${esc(s.phase)}</span>
        </div>
        ${s.statusNote ? `<p class="doc-note">${esc(s.statusNote)}</p>` : ''}
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
Engine ships in three phases. This is the public version — the internal roadmap
carries the sequencing arguments behind it.

## Phase 1 — MVP · prove the loop

Demonstrate the whole loop on a narrow slice: see a problem, fix it, verify it
moved. Not breadth — proof. Rank tracking, AI answer polling, the Unified
Visibility Score with confidence bands, the technical audit, and the first
deployable fixes.

**Status:** the measurement and diagnosis spine is live. Live A1/A2 ingestion is
waiting on third-party data access, and onboarding and billing are built but not
yet switched on against real accounts.

## Phase 2 — Depth · light up execution

Deepen visibility and diagnosis, and turn the Fix Queue into the product's
centre of gravity: content rewrites, meta and redirect fixes at scale, hreflang,
internal links, GitHub PR export, Google Business Profile automation, the entity
Copilot, and agency white-label.

**Status:** largely merged. The v1.5 pillars — entity and knowledge graph audit,
competitor intelligence, the backlink and mention index, and local SEO — all
landed in July 2026.

## Phase 3 — Platform · enterprise and agent-native

Log file analysis, a proprietary mention index, more answer engines, and the
enterprise surface around all of it.

**Status:** not started.

## What we will not do

Measurement polish for its own sake. Measuring AI visibility is table stakes;
the part that is hard, and the part we are building, is executing the fix into
your production surface and being able to roll it back.
`;

function buildRoadmap() {
  write('roadmap', shell({
    title: 'Roadmap',
    description: 'How Engine is phased — what is live now, what is next, and what we have deliberately chosen not to build.',
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
  const shipped = specs.filter((s) => s.status === 'shipped').length;
  write('', shell({
    title: 'Documentation',
    description: 'Engine documentation — features, changelog and roadmap for the AI visibility platform that fixes what it finds.',
    active: '/docs',
    depth: 1,
    body: `      <div class="prose">
        <p class="kicker">Documentation</p>
        <h1 class="doc-h1">Engine, documented</h1>
        <p class="doc-lede">The AI visibility platform that fixes what it finds.
        Unified SEO, GEO and local visibility, with an agentic Fix Queue that
        deploys, verifies and rolls back changes in your own CMS, code or
        Business Profile.</p>
      </div>

      <div class="card-grid">
        <a class="card" href="features/">
          <h3>Features →</h3>
          <p>Every module across visibility and diagnosis — what it does, what is
          in scope, and whether it has shipped.</p>
          <span class="card-meta">${shipped} of ${specs.length} shipped</span>
        </a>
        <a class="card" href="changelog/">
          <h3>Changelog →</h3>
          <p>Everything shipped, newest first. What changed, why it was wrong
          before, and what it now does.</p>
          <span class="card-meta">Updated continuously</span>
        </a>
        <a class="card" href="roadmap/">
          <h3>Roadmap →</h3>
          <p>The three phases, what is live now, and what we have deliberately
          chosen not to build.</p>
          <span class="card-meta">Phase 2 in progress</span>
        </a>
      </div>

      <section class="prose principles">
        <hr class="rule" />
        <h2>Two decisions that shape everything</h2>
        <p><b>The entity-first data model.</b> Answer engines and Google's
        Knowledge Graph reason over entities, not URLs. Engine stores one entity
        graph, so "how do we rank" and "who gets cited" are two readings of the
        same model rather than two products bolted together.</p>
        <p><b>The Finding → Action contract.</b> Every diagnosis has to name an
        executable fix. It was frozen before the execution layer existed, which
        is why a local SEO finding and a redirect chain reach production through
        the same deploy → verify → rollback path.</p>
        <p class="doc-note">Neither can be retrofitted, which is the whole reason
        they came first.</p>
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
buildFeatures(specs);
buildChangelog();
buildRoadmap();
console.log(`Done — ${specs.length} feature pages.`);
