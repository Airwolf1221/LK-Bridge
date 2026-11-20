/**
 * The tool lists' change signal (the owner's report of 20 November 2026: after approving arkona-2026-11-20-f4b, a Claude
 * session connected before the approval kept the old list until the bridge restarted).
 *
 * Every `tools/list` is worked out afresh for its caller (each MCP request gets its own server instance), so the bridge
 * never serves a stale list; but a connected client caches the list it was given and asks again only when told to. This
 * watches everything that can change a list (a pack's rules or approval, a project served or not, a profile's scope or
 * its low-level switch), compares a fingerprint of what would be listed, and when it moved tells the transport, which
 * sends `notifications/tools/list_changed` to every connected session listening for it (a 2026-07-28
 * `subscriptions/listen` stream). A change that leaves every list as it was sends nothing.
 */
export interface ToolListSource {
  /** The tool names listed now for anyone (each tool's own `listed()`, retired tools left out). */
  listed(): readonly string[];
  /** What decides a profile's list besides the tools: each profile's scope and low-level switch. */
  profiles(): readonly { readonly id: string; readonly scope: string; readonly showLowLevelTools: boolean }[];
}

export class ToolListWatch {
  private readonly listeners = new Set<() => void>();
  private last: string;
  private scheduled = false;

  constructor(private readonly source: ToolListSource) {
    this.last = this.fingerprint();
  }

  /** Told after every change that moved some list. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Something that may change a list changed: checked once the current turn of the event loop is done. */
  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.check();
    });
  }

  /** Compares now; tells the listeners when a list moved. Returns whether it did. */
  check(): boolean {
    const now = this.fingerprint();
    if (now === this.last) return false;
    this.last = now;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A listener that fails never stops the others.
      }
    }
    return true;
  }

  private fingerprint(): string {
    try {
      const tools = [...this.source.listed()].sort();
      const profiles = [...this.source.profiles()]
        .map((p) => `${p.id}:${p.scope}:${p.showLowLevelTools ? 1 : 0}`)
        .sort();
      return JSON.stringify([tools, profiles]);
    } catch {
      return this.last;
    }
  }
}
