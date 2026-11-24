import { THREAD_READ_HOLD_MS, createThreadRead } from "@ohmail/client-engine";
import type { StreamItemBox, StreamLook } from "./read-rule.js";

/** Measured text evidence for the current visit. */
export function previewEvidence(unread: (item: StreamItemBox) => boolean, owed: Set<string>) {
  let pending = createThreadRead();
  let ready = createThreadRead();
  const judged = judgedEvidence(unread);
  const dwell = (look: StreamLook | null): string[] => {
    if (!look) {
      pending.observe([], null, new Set(), 0);
      ready.observe([], null, new Set(), 0);
      judged.clear();
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
    judgedDwell: judged.observe,
    get due() {
      const first = Math.min(pending.due ?? Infinity, ready.due ?? Infinity, judged.due ?? Infinity);
      return first === Infinity ? null : first;
    },
    keepUnread(id: string): void {
      pending.keepUnread(id);
      ready.keepUnread(id);
      judged.forget(id);
    },
    reset(): void {
      pending = createThreadRead();
      ready = createThreadRead();
      judged.clear();
    },
  };
}

/** The first lines counted by a scroll whose input the iframe cannot report. */
const JUDGED_FIRST_LINES_PX = 140;

function judgedEvidence(unread: (item: StreamItemBox) => boolean) {
  let clocks = new Map<string, number>();
  return {
    observe(look: StreamLook, admit: boolean): string[] {
      const next = new Map<string, number>();
      const read: string[] = [];
      const foot = look.scrollTop + look.viewHeight;
      for (const item of look.items) {
        const since = clocks.get(item.id) ?? (admit ? look.at : undefined);
        if (since === undefined || item.height <= 0 || !unread(item)) continue;
        const firstLines = item.top + Math.min(item.height, JUDGED_FIRST_LINES_PX);
        if (item.top < look.scrollTop - 0.5 || firstLines > foot + 0.5) continue;
        if (look.at - since >= THREAD_READ_HOLD_MS) read.push(item.id);
        else next.set(item.id, since);
      }
      clocks = next;
      return read;
    },
    get due(): number | null {
      return clocks.size === 0 ? null : Math.min(...clocks.values()) + THREAD_READ_HOLD_MS;
    },
    forget: (id: string) => clocks.delete(id),
    clear: () => clocks.clear(),
  };
}
