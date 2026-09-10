import { el } from './dom.js';
import { screenName } from './format.js';

/**
 * What a route shows between the click and its data.
 *
 * Every route used to render the mono word "loading…" on an otherwise empty
 * screen. It said the product was working and nothing about what was coming,
 * and when the view arrived the screen grew from one line to its full height
 * in a single frame.
 *
 * A placeholder is only worth having if it is the shape of the screen it
 * stands in for, so these build the real layout — `.panel`, `.hm-lanes`,
 * `.fgroup`, `.card` — out of grey bars, and the arriving view fills the same
 * boxes rather than replacing a paragraph. Home, Findings and Fixes each get
 * their own, because those three are the screens a customer waits on. The
 * other nine share one panel of rows, which is the shape most of them already
 * have.
 *
 * Two details do the rest. The heading is the real one: the shell knows the
 * route before it fetches anything, so the title is painted once and the
 * loaded view writes the same words in the same place. And the bars are held
 * back for 140 ms by `.skel-body` in `styles.css`, so a route that answers
 * from a warm cache shows no placeholder at all — a flash of grey is worse
 * than a short pause.
 *
 * The widths are read off the loaded screens rather than invented, so the
 * placeholder is the same size as what replaces it. Nothing here claims a
 * count: four lanes are always four lanes, but every lane holds one card,
 * because how many are proposed is exactly what is not known yet.
 */

/** One filled bar. Height comes from the class, width from the caller. */
function bar(width: string, size = ''): HTMLElement {
  return el('div', { class: size ? `skel-bar ${size}` : 'skel-bar', style: `width:${width}` });
}

/** A bar pushed to the right end of a flex row, the way a count or a pill sits. */
function trailing(width: string, size = ''): HTMLElement {
  return el('div', { class: size ? `skel-bar ${size}` : 'skel-bar', style: `width:${width};margin-left:auto` });
}

/** The header every panel has: a title on the left, a count on the right. */
function panelHead(title: string, meta: string): HTMLElement {
  return el('header', {}, [bar(title, 'lg'), bar(meta)]);
}

/* ── Home ─────────────────────────────────────────────────────────────────── */

function homeBody(): HTMLElement[] {
  return [
    // Site health: the score, the three severity counts, "See all findings".
    el('section', { class: 'panel hm-health' }, [
      el('div', { class: 'hm-health-row' }, [
        bar('52px', 'xl'),
        el('div', { class: 'hm-sevs' }, [severityChip(), severityChip(), severityChip()]),
        // Same rule the real button follows: right-aligned on a wide row,
        // full width once the row wraps (`styles.css`, max-width 620px).
        el('div', { class: 'skel-bar blk skel-run' }),
      ]),
    ]),
    // What to fix first: three ranked rows.
    el('section', { class: 'panel' }, [
      panelHead('96px', '58px'),
      el('div', { class: 'hm-issues' }, [issueRow('44%'), issueRow('38%'), issueRow('50%')]),
    ]),
    // Fixes: the four lane counts.
    el('section', { class: 'panel' }, [
      panelHead('40px', '76px'),
      el('div', { class: 'hm-lanes' }, [laneCount(), laneCount(), laneCount(), laneCount()]),
    ]),
  ];
}

function severityChip(): HTMLElement {
  return el('div', { class: 'hm-sev' }, [bar('40px', 'lg')]);
}

function issueRow(width: string): HTMLElement {
  return el('div', { class: 'hm-issue' }, [
    el('div', { class: 'hm-issue-top' }, [bar(width, 'lg'), trailing('72px')]),
    el('div', { class: 'hm-issue-why' }, [bar('66%')]),
  ]);
}

function laneCount(): HTMLElement {
  return el('div', { class: 'hm-lane' }, [bar('16px', 'lg'), bar('58px')]);
}

/* ── Findings ─────────────────────────────────────────────────────────────── */

function findingsBody(): HTMLElement[] {
  return [
    el('section', { class: 'panel' }, [
      panelHead('72px', '118px'),
      el('div', { class: 'fgroups' }, [findingGroup('186px'), findingGroup('232px'), findingGroup('118px')]),
    ]),
  ];
}

function findingGroup(width: string): HTMLElement {
  return el('div', { class: 'fgroup' }, [
    el('div', { class: 'fgroup-head' }, [
      bar('62px', 'lg'),
      el('div', { class: 'fmain' }, [bar(width, 'lg'), el('div', { class: 'm' }, [bar('54px', 'sm')])]),
      trailing('82px', 'sm'),
    ]),
    el('p', { class: 'fgroup-why' }, [bar('58%')]),
    el('div', { class: 'fgroup-acts' }, [bar('126px', 'act'), bar('88px')]),
  ]);
}

/* ── Fixes ────────────────────────────────────────────────────────────────── */

function fixesBody(): HTMLElement[] {
  return [
    el('section', { class: 'panel fq' }, [
      el('div', { class: 'fq-head' }, [bar('68px', 'lg'), trailing('288px')]),
      el('div', { class: 'lanes' }, [fixLane(), fixLane(), fixLane(), fixLane()]),
    ]),
  ];
}

function fixLane(): HTMLElement {
  return el('div', { class: 'lane' }, [
    el('div', { class: 'lane-h' }, [bar('60px'), bar('16px', 'sm')]),
    el('div', { class: 'card' }, [
      el('div', { class: 'kind' }, [bar('104px', 'sm')]),
      el('div', { class: 'ttl' }, [bar('84%')]),
      el('div', { class: 'card-what' }, [bar('46%', 'sm')]),
      el('div', { class: 'card-diff' }, [
        el('div', { class: 'cd-row' }, [bar('30px', 'sm'), bar('58%', 'sm')]),
        el('div', { class: 'cd-row' }, [bar('36px', 'sm'), bar('72%', 'sm')]),
      ]),
      el('div', { class: 'card-link' }, [bar('118px', 'sm')]),
      el('div', { class: 'foot' }, [bar('62px', 'sm'), bar('24px', 'sm')]),
      el('div', { class: 'skel-bar act', style: 'width:100%;margin-top:9px' }),
    ]),
  ]);
}

/* ── Everything else ──────────────────────────────────────────────────────── */

/** One panel of rows, which is what most of the remaining routes render. */
function genericBody(): HTMLElement[] {
  return [
    el('section', { class: 'panel' }, [
      panelHead('84px', '44px'),
      el('div', { class: 'flist' }, [genericRow('52%'), genericRow('60%'), genericRow('40%')]),
    ]),
  ];
}

function genericRow(width: string): HTMLElement {
  return el('div', { class: 'frow' }, [
    el('div', { class: 'fmain' }, [bar(width, 'lg'), el('div', { class: 'm' }, [bar('34%', 'sm')])]),
    trailing('64px'),
  ]);
}

/* ── The route's own head ─────────────────────────────────────────────────── */

function head(id: string): HTMLElement[] {
  // Visibility is the one route whose heading is not its own name: it mounts a
  // tab strip and the open tab brings its page head, so writing "Visibility"
  // here would put up a title the loaded screen never shows.
  if (id === 'visibility') {
    return [
      el('div', { class: 'tabstrip' }, [bar('76px', 'lg'), bar('52px', 'lg'), bar('92px', 'lg'), bar('88px', 'lg'), bar('48px', 'lg')]),
      el('div', { class: 'pagehead' }, [bar('180px', 'xl')]),
    ];
  }
  const lines =
    id === 'findings'
      // Findings is the one page head with three parts: what the audit found,
      // what the crawl reached, and the button that runs another.
      ? [bar('54%'), bar('42%'), el('div', { class: 'skel-bar blk', style: 'width:112px' })]
      : [bar('46%')];
  return [el('div', { class: 'pagehead' }, [el('h1', {}, [screenName(id)]), ...lines])];
}

export function routeSkeleton(id: string): HTMLElement {
  const body = id === 'home' ? homeBody() : id === 'findings' ? findingsBody() : id === 'fixes' ? fixesBody() : genericBody();
  return el('div', { class: 'skel', role: 'status', 'aria-label': `Loading ${screenName(id)}` }, [
    ...head(id),
    el('div', { class: 'skel-body stack' }, body),
  ]);
}
