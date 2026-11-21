import { createThreadRead } from "@ohmail/client-engine";
import type { StreamItemBox, StreamLook } from "./read-rule.js";

/** Measured text evidence for the current visit. */
export function previewEvidence(unread: (item: StreamItemBox) => boolean, owed: Set<string>) {
  let pending = createThreadRead();
  let ready = createThreadRead();
  const dwell = (look: StreamLook | null): string[] => {
    if (!look) {
      pending.observe([], null, new Set(), 0);
      ready.observe([], null, new Set(), 0);
      return [];
    }
    pending.enter(look.at);
    ready.enter(look.at);
    const panels = look.items.flatMap((item) =>
      item.lines && unread(item)
        ? [{ id: item.id, height: item.height, ready: item.ready, ...item.lines }]
        : [],
    );
    const view = { top: look.scrollTop, bottom: look.scrollTop + look.viewHeight };
    const waiting = panels.filter((panel) => !panel.ready).map((panel) => ({ ...panel, ready: true }));
    for (const id of pending.observe(waiting, view, new Set(waiting.map((p) => p.id)), look.at)) owed.add(id);
    const loaded = panels.filter((panel) => panel.ready);
    return ready.observe(loaded, view, new Set(loaded.map((p) => p.id)), look.at);
  };
  return {
    dwell,
    get due() {
      const first = Math.min(pending.due ?? Infinity, ready.due ?? Infinity);
      return first === Infinity ? null : first;
    },
    keepUnread(id: string): void {
      pending.keepUnread(id);
      ready.keepUnread(id);
    },
    reset(): void {
      pending = createThreadRead();
      ready = createThreadRead();
    },
  };
}
