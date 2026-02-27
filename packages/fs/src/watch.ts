// @hermetic/fs — File watching utilities
//
// Uses FileSystemObserver when available, falls back to polling at 500ms.

import type { WatchCallback, WatchEvent, WatchEventType } from "./types.js";

/** Check if FileSystemObserver is available (Chrome 129+) */
export function hasFileSystemObserver(): boolean {
  return typeof globalThis !== "undefined" && "FileSystemObserver" in globalThis;
}

/**
 * Create a native FileSystemObserver watcher.
 * Returns null if FileSystemObserver is not available.
 */
export function createNativeWatcher(
  dirHandle: FileSystemDirectoryHandle,
  callback: WatchCallback,
): { stop: () => void } | null {
  if (!hasFileSystemObserver()) return null;

  try {
    // @ts-expect-error — FileSystemObserver is not yet in TS lib types
    const observer = new FileSystemObserver(async (records: any[]) => {
      for (const record of records) {
        const path = record.relativePathComponents.join("/");
        const type: WatchEventType =
          record.type === "appeared"
            ? "create"
            : record.type === "disappeared"
              ? "delete"
              : "modify";
        callback({ type, path: "/" + path });
      }
    });

    observer.observe(dirHandle, { recursive: true });
    return {
      stop: () => observer.disconnect(),
    };
  } catch {
    return null; // Fall back to polling
  }
}

/**
 * Create a debounced watcher that batches rapid changes.
 * Deduplicates events per path, keeping only the latest event type.
 */
export function createDebouncedWatcher(
  subscribe: (cb: WatchCallback) => () => void,
  callback: WatchCallback,
  debounceMs = 100,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: WatchEvent[] = [];

  const flush = () => {
    const events = pending;
    pending = [];
    timer = null;
    // Deduplicate: only fire latest event per path
    const latest = new Map<string, WatchEvent>();
    for (const e of events) latest.set(e.path, e);
    for (const event of latest.values()) callback(event);
  };

  return subscribe((event) => {
    pending.push(event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
}

/**
 * Create a file watcher using polling.
 * Returns an unsubscribe function.
 */
export function createWatcher(
  getEntries: () => Promise<Map<string, { mtime: number; size: number }>>,
  callback: WatchCallback,
  intervalMs = 500,
): () => void {
  // Polling fallback
  let snapshot = new Map<string, string>();
  let running = true;

  const poll = async () => {
    if (!running) return;
    try {
      const current = await getEntries();
      const currentKeys = new Set(current.keys());
      const prevKeys = new Set(snapshot.keys());

      // Check for new or modified entries
      for (const [path, info] of current) {
        const key = `${info.mtime}:${info.size}`;
        const prev = snapshot.get(path);
        if (prev === undefined) {
          if (snapshot.size > 0) {
            // Only emit create if we had a previous snapshot
            callback({ type: "create", path });
          }
        } else if (prev !== key) {
          callback({ type: "modify", path });
        }
      }

      // Check for deleted entries
      for (const path of prevKeys) {
        if (!currentKeys.has(path)) {
          callback({ type: "delete", path });
        }
      }

      // Update snapshot
      snapshot = new Map();
      for (const [path, info] of current) {
        snapshot.set(path, `${info.mtime}:${info.size}`);
      }
    } catch {
      // Ignore poll errors
    }
  };

  const interval = setInterval(poll, intervalMs);
  // Initial snapshot
  poll();

  return () => {
    running = false;
    clearInterval(interval);
  };
}
