import { el } from '../dom.js';
import { bandPositions } from '../format.js';
import { fetchPulse } from '../api.js';
import type { AppContext } from '../context.js';
import type { PulseData, ChannelContribution } from '../types.js';

function contributionCell(c: ChannelContribution): HTMLElement {
  const isBand = c.low !== undefined && c.high !== undefined;
  const meterPct = isBand ? (c.low! + c.high!) / 2 : c.value;
  return el('div', { class: 'cell' }, [
    el('div', { class: 'top' }, [
      el('h4', {}, [c.label]),
      isBand ? el('span', { class: 'tagband' }, ['± range']) : null,
    ]),
    el('div', { class: 'v num' }, [
      String(Math.round(c.value)),
      isBand ? el('span', { class: 'v-range' }, [`–${Math.round(c.high!)}`]) : null,
    ]),
    el('div', { class: 'sub' }, [c.sub]),
    el('div', { class: 'meter' }, [el('i', { style: `width:${meterPct}%` })]),
  ]);
}

function heroPanel(d: PulseData): HTMLElement {
  const score = d.score!; // caller only renders this when d.score is non-null
  const b = bandPositions(score);
  const track = el(
    'div',
    { class: 'band-track', title: 'We report AI-influenced metrics as a range, never a false point.' },
    [el('i', { style: `left:${b.leftPct}%;right:${b.rightPct}%` }), el('b', { style: `left:${b.tickPct}%` })],
  );

  return el('section', { class: 'panel hero' }, [
    el('div', { class: 'label' }, ['Unified Visibility Score']),
    el('div', { class: 'scorewrap' }, [
      el('div', { class: 'score num' }, [String(score.point)]),
      el('div', { class: 'band' }, [
        track,
        el('div', { class: 'band-nums' }, [
          el('span', {}, [String(score.low)]),
          el('span', {}, [String(score.high)]),
        ]),
      ]),
    ]),
    el('div', { class: 'hero-meta' }, [
      el('span', { class: 'num' }, ['organic + AI + local, weighted by your traffic mix']),
    ]),
    el('div', { class: 'contrib' }, d.contributions.map(contributionCell)),
  ]);
}

/**
 * The panel shown when the project has never been polled — the honest state
 * this view lacked entirely before: it always rendered `MOCK_PULSE`'s score
 * of 64, band 57–72, and three invented wins/risks for a site nothing had
 * measured. A project this genuinely new has neither, and 0 would read as
 * "zero visibility" rather than "nothing measured yet".
 */
function emptyPanel(): HTMLElement {
  return el('section', { class: 'panel hero' }, [
    el('div', { class: 'label' }, ['Unified Visibility Score']),
    el('div', { class: 'fq-note' }, [
      'No visibility data yet. The score appears once search rankings and AI answers have been ' +
        'sampled for this project’s keywords and prompts.',
    ]),
  ]);
}

export async function pulseView(_ctx: AppContext): Promise<HTMLElement> {
  let data: PulseData | null = null;
  let loadError: string | null = null;
  try {
    data = await fetchPulse();
  } catch (err) {
    // Same rule as the Fix Queue and Audit views: an unreachable API is not
    // an empty Pulse, and this view will not invent a score to paper over
    // the difference.
    loadError = (err as Error).message;
  }

  if (!data) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, ['Pulse'])]),
      el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load Pulse: ${loadError}`])]),
    ]);
  }

  const d = data;
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Pulse']),
      el('p', {}, [
        d.score
          ? `Unified visibility is ${d.score.point} (${d.score.low}–${d.score.high}) across ${d.keywordsTracked} tracked keyword${d.keywordsTracked === 1 ? '' : 's'} and ${d.citationSamples} AI citation sample${d.citationSamples === 1 ? '' : 's'}.`
          : 'This project has no polled data yet.',
      ]),
    ]),
    d.score ? heroPanel(d) : emptyPanel(),
  ]);
}
