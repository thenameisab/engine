/**
 * A modal dialog: one panel over a dimmed page, closed by its button, Escape,
 * or a click on the backdrop. Focus moves into the panel on open and returns
 * to the element that opened it on close.
 *
 * Kept deliberately small. It exists because the product had no dialog at all
 * and reached for window.prompt() instead; the Integrations page is its first
 * user, for the connect panel each provider opens.
 */
import { el } from './dom.js';

export interface DialogHandle {
  close(): void;
  /** Replace the panel's content in place, keeping the dialog open. */
  setContent(content: HTMLElement): void;
  readonly isOpen: boolean;
}

export interface DialogOptions {
  /** Rendered in the panel's header, before the close button. */
  title: HTMLElement | string;
  content: HTMLElement;
  /** Accessible name when `title` is an element. */
  label?: string;
  onClose?: () => void;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function openDialog(options: DialogOptions): DialogHandle {
  const opener = document.activeElement as HTMLElement | null;
  const body = el('div', { class: 'dialog-body' }, [options.content]);
  const closeBtn = el('button', { class: 'iconbtn dialog-close', title: 'Close', 'aria-label': 'Close' , html: '&#x2715;' });
  const panel = el('div', {
    class: 'dialog',
    role: 'dialog',
    'aria-modal': 'true',
    ...(options.label ? { 'aria-label': options.label } : {}),
  }, [
    el('div', { class: 'dialog-head' }, [
      typeof options.title === 'string' ? el('h2', { class: 'dialog-title' }, [options.title]) : options.title,
      closeBtn,
    ]),
    body,
  ]);
  const overlay = el('div', { class: 'dialog-overlay' }, [panel]);

  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    overlay.classList.remove('in');
    document.removeEventListener('keydown', onKey);
    removeEventListener('hashchange', close);
    const remove = () => overlay.remove();
    // Let the fade run, but never depend on transitionend firing.
    overlay.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 220);
    options.onClose?.();
    opener?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  // The dialog lives on document.body, outside the routed view, so a route
  // change would otherwise leave it open over the next screen.
  addEventListener('hashchange', close);

  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  const first = panel.querySelector<HTMLElement>(FOCUSABLE);
  (first ?? panel).focus?.();

  return {
    close,
    setContent(content) {
      body.replaceChildren(content);
    },
    get isOpen() {
      return open;
    },
  };
}
