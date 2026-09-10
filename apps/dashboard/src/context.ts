/** Shared services a view can use, injected by the shell. */
export interface AppContext {
  /** Transient bottom-corner message. */
  toast(message: string): void;
  /** Navigate to a route (hash). */
  navigate(route: string): void;
  /**
   * Re-read the client and site list and repaint the workspace column.
   *
   * Renaming a client or a site from a screen changes what the permanent
   * column, the topbar chip and the breadcrumb say. Without this they keep
   * the old name until the next full reload, so the rename looks as though it
   * did not take — the same defect the column was built to fix, one level in.
   */
  refreshWorkspace(): Promise<void>;
}

/** A view renders into a container asynchronously (it may fetch first). */
export type View = (ctx: AppContext) => Promise<HTMLElement>;
