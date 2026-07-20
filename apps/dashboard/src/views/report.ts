/**
 * M2.5 "branded reports shipping": the report is a self-contained branded
 * HTML document meant to be viewed/printed/shared on its own, not chrome
 * inside the dashboard shell — rendered here in an iframe (a same-window
 * preview) with a link to open it standalone for printing/sharing.
 */
import { el } from '../dom.js';
import { fetchReportUrl, getAccountId } from '../api.js';
import type { AppContext } from '../context.js';

export async function reportView(ctx: AppContext): Promise<HTMLElement> {
  const accountId = getAccountId();
  if (!accountId) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, ['Branded report'])]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'fq-note' }, ['Pick a client from the Clients grid first.']),
      ]),
    ]);
  }

  let url: string | null = null;
  let loadError: string | null = null;
  try {
    url = await fetchReportUrl(accountId);
  } catch (err) {
    loadError = (err as Error).message;
  }

  if (!url) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, ['Branded report'])]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'fq-note' }, [`Could not load the report: ${loadError}`]),
      ]),
    ]);
  }

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Branded report']),
      el('p', {}, ['A shareable, printable summary for this client — open it standalone to save as PDF.']),
      el('a', { href: url, target: '_blank', rel: 'noopener', class: 'btn primary' }, ['Open standalone ↗']),
    ]),
    el('section', { class: 'panel', style: 'padding:0;overflow:hidden' }, [
      el('iframe', { src: url, style: 'width:100%;height:70vh;border:0;background:#fff' }),
    ]),
  ]);
}
