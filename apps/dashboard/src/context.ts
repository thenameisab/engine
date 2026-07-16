/** Shared services a view can use, injected by the shell. */
export interface AppContext {
  /** Transient bottom-corner message. */
  toast(message: string): void;
  /** Navigate to a route (hash). */
  navigate(route: string): void;
}

/** A view renders into a container asynchronously (it may fetch first). */
export type View = (ctx: AppContext) => Promise<HTMLElement>;
