/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, MemoryMirrorStore, OhmailEngine, type MirrorRecord } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../../webapp/messages/en.json";

/**
 * THE DESKTOP'S OHBOX SAVES A READ WHEN IT SHOWS ONE. Paired and standalone windows
 * mount the web client's `AppShell` with an engine the window built (`DesktopGate`: `demo={false}`
 * plus `engine`), so they share the Ohbox's arm, and this is that shape: an open puts the glance
 * read on the outbox and the wire while the message is on screen, and the count follows it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The window's store commits a task later, as the sidecar's and IndexedDB's writes do. */
class LaterTaskDisk extends MemoryMirrorStore {
  readonly disk: string[] = [];
  protected override async transact(...args: unknown[]): Promise<void> {
    const [puts = []] = args as [MirrorRecord[]?];
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    for (const p of puts) this.disk.push(`put ${p.type}`);
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let wire: Array<{ kind: string; ids: string[]; unread?: boolean; via?: string }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  wire = [];
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (this: FixturesAdapter, m, opts) {
    const r = m as { kind: string; messageIds?: string[]; unread?: boolean; via?: string };
    wire.push({ kind: r.kind, ids: r.messageIds ?? [], unread: r.unread, via: r.via });
    return real.call(this, m, opts);
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const count = (): number => Number(/(\d+) unread/.exec(host!.textContent ?? "")?.[1] ?? NaN);
const rowOf = (id: string): HTMLElement => host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;

describe("the desktop window's Ohbox", () => {
  it("an open saves the read to the outbox and the wire while the message is still open", async () => {
    const store = new LaterTaskDisk();
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, storePolicy: { mode: "full" } });
    const { AppShell } = await import("../../webapp/app/shell/AppShell");
    window.location.hash = "#/ohbox";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell as never, { demo: false, engine } as never) }),
        }),
      }));
    });
    for (let i = 0; i < 12; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const row = host.querySelector<HTMLElement>('.row[data-unseen="1"][data-id]');
    expect(row, "the fixture Ohbox shows no unread row").not.toBeNull();
    const id = row!.dataset.id!;
    const before = count();
    await act(async () => { row!.click(); });            // the cursor lands
    await act(async () => { rowOf(id).click(); });       // …a second click is the open
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(wire.filter((w) => w.kind === "mark_seen" && w.ids.includes(id)), "the desktop never sent the read")
      .toEqual([{ kind: "mark_seen", ids: [id], unread: false, via: "glance" }]);
    expect(store.disk.some((d) => d.startsWith("put ")), "the outbox row never reached the disk").toBe(true);
    expect(rowOf(id).dataset.unseen).toBeUndefined();
    expect(count(), "the count and the row disagree").toBe(before - 1);
  });
});
