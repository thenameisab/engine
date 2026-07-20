/** Inline SVG icon markup (stroke: currentColor). Authored, never user data. */
export const ICONS = {
  pulse: '<path d="M3 12h4l2 6 4-14 2 8h6" stroke-linecap="round" stroke-linejoin="round"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4-4" stroke-linecap="round"/>',
  serp: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4-4" stroke-linecap="round"/><path d="M8 11h6M11 8v6" stroke-linecap="round"/>',
  kanban: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="10" rx="1.5"/>',
  doc: '<path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5" stroke-linejoin="round"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" stroke-linecap="round" stroke-linejoin="round"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke-linecap="round"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16" stroke-linecap="round"/>',
  signout: '<path d="M15 12H4M4 12l4-4M4 12l4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowUp: '<path d="M7 17 17 7M17 7H9M17 7v8" stroke-linecap="round" stroke-linejoin="round"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke-linejoin="round"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6 4.5 4.5M19.5 19.5 18 18M18 6l1.5-1.5M4.5 19.5 6 18" stroke-linecap="round"/>',
  check: '<path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/>',
  logo: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  clients: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
} as const;

export function icon(markup: string, cls = ''): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"${cls ? ` class="${cls}"` : ''}>${markup}</svg>`;
}
