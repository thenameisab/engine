/** Minimal hyperscript helper — no framework, just a typed createElement. */
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void)> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as (e: Event) => void);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'html') {
      node.innerHTML = String(v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Parse a trusted SVG string into a node (icons are authored inline, never user data). */
export function svg(markup: string): SVGElement {
  const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrap.innerHTML = markup;
  const child = wrap.firstElementChild as SVGElement | null;
  return child ?? wrap;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
