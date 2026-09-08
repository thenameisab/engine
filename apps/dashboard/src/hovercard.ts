/**
 * Hover cards, so explanation stops competing with the interface.
 *
 * The integrations screen had grown four stacked paragraphs per provider: why
 * a button is disabled, what a vendor gates behind an access request, that a
 * scope grants writes, which APIs to enable first. Every sentence was true and
 * worth saying once. Together they buried the two things a person actually
 * came to do — connect, and pick a property — under text they had already read.
 *
 * So the detail moves behind an affordance and the card keeps only what has to
 * be seen without asking. The rule this module exists to support: **if a
 * sentence is not needed to make the next decision, it belongs in a hover
 * card.**
 *
 * Three properties that make this an affordance rather than a trap:
 *
 *   - **Keyboard reachable.** The trigger is a `<button>`, not a styled span,
 *     so Tab reaches it and Enter opens it. A tooltip only a mouse can open
 *     hides content from anyone not using one.
 *   - **Touch works.** Hover does not exist on a phone. Click toggles, so the
 *     same trigger works for both without a second component.
 *   - **It does not trap.** Escape closes, a click elsewhere closes, and
 *     scrolling closes. A panel that outlives its context is worse than no
 *     panel.
 */
import { el } from './dom.js';

let openCard: HTMLElement | null = null;
let openTrigger: HTMLElement | null = null;
/**
 * Whether the open card was opened by a click rather than a hover.
 *
 * Without this the two interactions fight: hover opens the card, and the click
 * a moment later toggles it straight back off — so a mouse user watches the
 * thing vanish at the exact moment they clicked to keep it. Pinned cards
 * survive the pointer leaving; unpinned ones do not.
 */
let openPinned = false;

/** One shared listener set rather than one per card, attached on first use. */
let listenersBound = false;

function closeOpen(): void {
  if (openCard) openCard.remove();
  if (openTrigger) openTrigger.setAttribute('aria-expanded', 'false');
  openCard = null;
  openTrigger = null;
  openPinned = false;
}

function bindGlobalListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeOpen();
  });
  document.addEventListener('click', (e) => {
    if (!openCard) return;
    const target = e.target as Node | null;
    if (target && (openCard.contains(target) || openTrigger?.contains(target))) return;
    closeOpen();
  });
  // Capture phase and passive: the card is absolutely positioned against the
  // page, so any scroll in any container detaches it from its trigger.
  document.addEventListener('scroll', () => closeOpen(), { capture: true, passive: true });
  window.addEventListener('resize', () => closeOpen());
}

export interface HoverCardContent {
  /** Short heading. Omit when the body is a single sentence. */
  title?: string;
  /** Body paragraphs. */
  body?: string[];
  /** Steps or requirements, rendered as a list. */
  list?: string[];
  /** A link out, when the real answer lives in vendor documentation. */
  link?: { href: string; label: string };
}

function buildCard(content: HoverCardContent): HTMLElement {
  return el('div', { class: 'hovercard', role: 'dialog' }, [
    content.title ? el('div', { class: 'hovercard-title' }, [content.title]) : null,
    ...(content.body ?? []).map((p) => el('p', {}, [p])),
    content.list && content.list.length > 0
      ? el('ul', {}, content.list.map((item) => el('li', {}, [item])))
      : null,
    content.link
      ? el('a', { href: content.link.href, target: '_blank', rel: 'noreferrer noopener' }, [
          `${content.link.label} ↗`,
        ])
      : null,
  ].filter(Boolean) as HTMLElement[]);
}

/**
 * Place the card near its trigger, kept inside the viewport.
 *
 * Fixed positioning against the viewport rather than absolute against a
 * parent, because the trigger sits inside panels with their own overflow and
 * stacking contexts — an absolutely positioned card gets clipped by the first
 * ancestor that scrolls.
 */
function position(card: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  card.style.visibility = 'hidden';
  document.body.append(card);
  const cardRect = card.getBoundingClientRect();

  let left = rect.left + rect.width / 2 - cardRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - cardRect.width - margin));

  // Below by default; above when there is not room, which is what happens to
  // the last provider card on a short window.
  const below = rect.bottom + margin;
  const top = below + cardRect.height > window.innerHeight - margin ? rect.top - cardRect.height - margin : below;

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(Math.max(margin, top))}px`;
  card.style.visibility = '';
}

let cardSeq = 0;

/**
 * An info trigger with a hover card attached.
 *
 * `label` is the accessible name — what a screen reader announces — so it must
 * say what the card is about ("Why this is disabled"), not "more information".
 */
export function infoCard(label: string, content: HoverCardContent): HTMLButtonElement {
  bindGlobalListeners();
  const id = `hovercard-${++cardSeq}`;

  const trigger = el('button', {
    class: 'hovercard-trigger',
    type: 'button',
    'aria-label': label,
    'aria-expanded': 'false',
    'aria-controls': id,
  }, ['?']) as HTMLButtonElement;

  const show = (pinned: boolean) => {
    if (openTrigger === trigger) {
      // Already showing from a hover; a click promotes it rather than
      // rebuilding it, so the card does not flicker under the pointer.
      openPinned = openPinned || pinned;
      return;
    }
    closeOpen();
    const card = buildCard(content);
    card.id = id;
    position(card, trigger);
    openCard = card;
    openTrigger = trigger;
    openPinned = pinned;
    trigger.setAttribute('aria-expanded', 'true');
  };

  trigger.addEventListener('mouseenter', () => show(false));
  trigger.addEventListener('focus', () => show(false));
  trigger.addEventListener('blur', () => {
    // A pinned card stays: focus moving into the card itself to reach a link
    // must not dismiss it.
    if (openTrigger === trigger && !openPinned) closeOpen();
  });
  trigger.addEventListener('click', (e) => {
    // Pin on click, unpin-and-close on a second one. On touch there is no
    // hover at all, so the first tap both opens and pins.
    e.preventDefault();
    e.stopPropagation();
    if (openTrigger === trigger && openPinned) closeOpen();
    else show(true);
  });
  trigger.addEventListener('mouseleave', () => {
    // Only close on mouse-out when the card was not pinned and the pointer did
    // not land on the card, so a link inside it stays reachable.
    setTimeout(() => {
      if (
        openTrigger === trigger &&
        !openPinned &&
        openCard &&
        !openCard.matches(':hover') &&
        document.activeElement !== trigger
      ) {
        closeOpen();
      }
    }, 120);
  });

  return trigger;
}

/**
 * Attach a hover card to an existing element instead of adding a `?` next to it.
 *
 * Used where the element is already the thing being explained — a status chip,
 * a disabled button's wrapper — and a second affordance beside it would be
 * noise.
 */
export function attachCard(target: HTMLElement, label: string, content: HoverCardContent): HTMLElement {
  bindGlobalListeners();
  target.classList.add('has-hovercard');
  target.setAttribute('aria-label', label);
  if (!target.hasAttribute('tabindex') && target.tagName !== 'BUTTON') target.setAttribute('tabindex', '0');

  const show = () => {
    if (openCard?.dataset.owner === label) return;
    closeOpen();
    const card = buildCard(content);
    card.dataset.owner = label;
    position(card, target);
    openCard = card;
    openTrigger = target;
  };

  target.addEventListener('mouseenter', show);
  target.addEventListener('focus', show);
  target.addEventListener('mouseleave', () => {
    setTimeout(() => {
      if (openCard && !openPinned && !openCard.matches(':hover')) closeOpen();
    }, 120);
  });
  target.addEventListener('blur', () => closeOpen());
  return target;
}
