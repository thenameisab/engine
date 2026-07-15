import { el, svg } from '../dom.js';
import { icon, ICONS } from '../icons.js';
import { bandPositions, sparklinePath, sparklineArea, fmtDelta, fmtInt } from '../format.js';
import { fetchPulse } from '../api.js';
import { MOCK_PULSE } from '../mock.js';
import type { AppContext } from '../context.js';
import type { PulseData, ChannelContribution, SignalRow } from '../types.js';

function contributionCell(c: ChannelContribution): HTMLElement {
  const isBand = c.low !== undefined && c.high !== undefined;
  const meterPct = isBand ? ((c.low! + c.high!) / 2) : c.value;
  return el('div', { class: 'cell' }, [
    el('div', { class: 'top' }, [
      el('h4', {}, [c.label]),
      isBand ? el('span', { class: 'tagband' }, ['± range']) : null,
    ]),
    el('div', { class: 'v num' }, [
      String(Math.round(c.value)),
      isBand
        ? el('span', { class: 'v-range' }, [`–${Math.round(c.high!)}`])
        : null,
    ]),
    el('div', { class: 'sub' }, [c.sub]),
    el('div', { class: 'meter' }, [el('i', { style: `width:${meterPct}%` })]),
  ]);
}

function signalRow(s: SignalRow, kind: 'g' | 'r'): HTMLElement {
  return el('div', { class: 'row' }, [
    el('span', { class: `dot ${kind}` }),
    el('div', {}, [
      el('div', { class: 't' }, [s.title]),
      el('div', { class: 'm' }, [s.meta]),
    ]),
    el('span', { class: `mv ${kind}` }, [`${s.move >= 0 ? '+' : '−'}${Math.abs(s.move)}`]),
  ]);
}

function heroPanel(d: PulseData): HTMLElement {
  const b = bandPositions(d.score);
  const track = el('div', { class: 'band-track', title: 'We report AI-influenced metrics as a range, never a false point.' }, [
    el('i', { style: `left:${b.leftPct}%;right:${b.rightPct}%` }),
    el('b', { style: `left:${b.tickPct}%` }),
  ]);

  const spark = svg(
    `<svg class="spark" viewBox="0 0 560 72" preserveAspectRatio="none" fill="none">
      <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.14"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${sparklineArea(d.trend, 560, 72, 8)}" fill="url(#fill)"/>
      <path d="${sparklinePath(d.trend, 560, 72, 8)}" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  );

  const scoreEl = el('div', { class: 'score num', id: 'scoreNum' }, ['0']);
  countUp(scoreEl, d.score.point);

  return el('section', { class: 'panel hero' }, [
    el('div', { class: 'label' }, ['Unified Visibility Score']),
    el('div', { class: 'scorewrap' }, [
      scoreEl,
      el('div', { class: 'band' }, [
        track,
        el('div', { class: 'band-nums' }, [
          el('span', {}, [String(d.score.low)]),
          el('span', {}, [String(d.score.high)]),
        ]),
      ]),
    ]),
    el('div', { class: 'hero-meta' }, [
      el('span', { class: `delta ${d.deltaVsPrior >= 0 ? '' : 'down'}`, html: icon(ICONS.arrowUp) + fmtDelta(d.deltaVsPrior) }),
      el('span', { class: 'num' }, ['vs. 30 days ago · organic + AI + local, weighted by your traffic mix']),
    ]),
    spark,
    el('div', { class: 'contrib' }, d.contributions.map(contributionCell)),
  ]);
}

function countUp(node: HTMLElement, target: number): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = fmtInt(target);
    return;
  }
  const dur = 650;
  const t0 = performance.now();
  const ease = (x: number) => 1 - Math.pow(1 - x, 3);
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    node.textContent = fmtInt(ease(p) * target);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function pulseView(ctx: AppContext): Promise<HTMLElement> {
  let data: PulseData = MOCK_PULSE;
  try {
    data = await fetchPulse();
    ctx.setBadge('live');
  } catch {
    ctx.setBadge('sample');
  }

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Pulse']),
      el('p', { html: `Unified visibility is <b>${fmtDelta(data.deltaVsPrior)} points</b> this month — and <b>${MOCK_PULSE.risks.length} risks</b> need attention.` }),
    ]),
    el('div', { class: 'grid' }, [
      heroPanel(data),
      el('div', { class: 'stack' }, [
        el('section', { class: 'panel' }, [
          el('header', {}, [el('h3', {}, ['Top wins']), el('span', { class: 'more' }, ['This week'])]),
          el('div', { class: 'list' }, data.wins.map((w) => signalRow(w, 'g'))),
        ]),
        el('section', { class: 'panel' }, [
          el('header', {}, [el('h3', {}, ['Top risks']), el('span', { class: 'more' }, ['Needs attention'])]),
          el('div', { class: 'list' }, data.risks.map((r) => signalRow(r, 'r'))),
        ]),
      ]),
    ]),
  ]);
}
