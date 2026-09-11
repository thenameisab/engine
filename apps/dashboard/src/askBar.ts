/**
 * The floating ask bar.
 *
 * A place to type a question without going to look for one. It sits over the
 * screen it belongs to, takes a question, and hands it to Driver — the answer
 * is never written here. That division is deliberate and it is what keeps the
 * product one product: an inline answer would make this a second Driver with a
 * narrower rendering of the same parts, which is the "two renderings of one
 * object" §4.5 warns about, applied to the whole surface rather than to a row.
 *
 * So sending navigates. The question travels in memory rather than in the hash
 * (see `askInDriver`), the Driver screen opens with it already being asked, and
 * the conversation it starts is a real thread with a real id the customer can
 * come back to. A question asked from here and a question typed there are the
 * same question in the same place.
 *
 * Mounted on Home today. Step 10 puts it on the other screens with that
 * screen's context attached, which is why it is a component rather than sixty
 * lines inside `views/home.ts` — `buildSystemPrompt` already accepts a
 * `screenContext` and nothing passes one yet.
 *
 * It is `position: fixed`, and it is a child of the view that mounts it: the
 * shell replaces the view's subtree on every navigation, so the bar leaves with
 * the screen it belongs to and no listener has to remember to remove it.
 */
import { el } from './dom.js';
import { icon, ICONS } from './icons.js';
import { askInDriver } from './views/driver.js';
import type { AppContext } from './context.js';

export interface AskBarOptions {
  /** What the empty bar invites. Screen-specific, because a good prompt names the screen's own nouns. */
  placeholder?: string;
}

export function askBar(ctx: AppContext, opts: AskBarOptions = {}): HTMLElement {
  const input = el('input', {
    class: 'askbar-input',
    type: 'text',
    autocomplete: 'off',
    placeholder: opts.placeholder ?? 'Ask about this site…',
    'aria-label': 'Ask Driver a question',
  }) as HTMLInputElement;

  const send = el('button', {
    class: 'askbar-send',
    title: 'Ask',
    'aria-label': 'Ask',
    html: icon(ICONS.arrowUp),
  });

  const bar = el('div', { class: 'askbar' }, [
    el('div', { class: 'askbar-box' }, [
      el('span', { class: 'askbar-icon', html: icon(ICONS.ask) }),
      input,
      send,
    ]),
  ]);

  function go(): void {
    const question = input.value.trim();
    if (!question) {
      input.focus();
      return;
    }
    askInDriver(ctx, question);
  }

  send.addEventListener('click', go);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      go();
    }
  });

  // The bar has something to say only once there is something in it. Empty, the
  // send button is a control that does nothing, and a disabled button beside an
  // empty field reads as broken rather than as waiting.
  const paint = (): void => {
    bar.classList.toggle('has-text', input.value.trim() !== '');
  };
  input.addEventListener('input', paint);
  input.addEventListener('focus', () => bar.classList.add('focused'));
  input.addEventListener('blur', () => bar.classList.remove('focused'));

  // The rise. Added on the frame after mount rather than animated from a class
  // on the element itself, because a transition that starts in the same frame
  // as the insert is dropped by the browser — the same reason the toast waits
  // two frames before adding `.in`.
  requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('in')));

  return bar;
}
