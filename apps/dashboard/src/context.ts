import type { DataSource } from './types.js';

/** Shared services a view can use, injected by the shell. */
export interface AppContext {
  /** Show whether the current view is on live API data or the built-in sample. */
  setBadge(source: DataSource): void;
  /** Transient bottom-corner message. */
  toast(message: string): void;
  /** Navigate to a route (hash). */
  navigate(route: string): void;
}

/** A view renders into a container asynchronously (it may fetch first). */
export type View = (ctx: AppContext) => Promise<HTMLElement>;
