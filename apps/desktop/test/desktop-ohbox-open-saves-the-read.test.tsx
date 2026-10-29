/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, MemoryMirrorStore, OhmailEngine, type MirrorRecord, type SyncChange } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../../webapp/messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "../../webapp/test/fixtures/thread-layout.js";

/**
 * THE DESKTOP'S OHBOX SAVES A READ WHEN IT SHOWS ONE. Paired and standalone windows mount the web
 * client's `AppShell` with an engine the window built (`DesktopGate`: `demo={false}` plus `engine`),
 * so they share the Ohbox's thread-read rule, and this is that shape: an open puts the glance read
 * of the message on screen on the outbox and the wire once its top was on screen for the dwell,
 * while it is still open, and the count follows it; a j preview passed within the rest writes nothing,
 * one rested on reads. The window's reader is laid out (`thread-layout.ts`).
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

let layout: ThreadLayout;
beforeEach(() => {
  vi.useFakeTimers();
  layout = stubThreadLayout();
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
  layout.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const count = (): number => Number(/(\d+) unread/.exec(host!.textContent ?? "")?.[1] ?? NaN);
const rowOf = (id: string): HTMLElement => host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;

/** The window as `DesktopGate` mounts it: the web client's shell over an engine the window built. */
async function mountWindow(store: LaterTaskDisk): Promise<void> {
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
}

describe("the desktop window's Ohbox", () => {
  it("an open saves the read to the outbox and the wire while the message is still open; a preview rested on reads too", async () => {
    const store = new LaterTaskDisk();
    await mountWindow(store);

    const first = host!.querySelector<HTMLElement>('.row[data-unseen="1"][data-id]');
    expect(first, "the fixture Ohbox shows no unread row").not.toBeNull();
    // A preview: the first row on screen, resting well past the rest, the window in front. Rested on,
    // it reads (owner 2026-10-28: "no it stays like that and does not fade, that's the issue").
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(wire.filter((w) => w.kind === "mark_seen"), "the rested preview wrote no read")
      .toEqual([{ kind: "mark_seen", ids: [first!.dataset.id!], unread: false, via: "glance" }]);
    // The open, of the next unread row: what it writes alone.
    wire = [];
    store.disk.length = 0;
    const row = host!.querySelector<HTMLElement>('.row[data-unseen="1"][data-id]');
    expect(row, "the fixture Ohbox shows no second unread row").not.toBeNull();
    const id = row!.dataset.id!;
    const before = count();
    await act(async () => { rowOf(id).click(); });       // a click is the open
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(wire.filter((w) => w.kind === "mark_seen"), "the write waits for the dwell").toEqual([]);
    await layout.passDwell();                            // its top on screen for the dwell: read

    expect(wire.filter((w) => w.kind === "mark_seen" && w.ids.includes(id)), "the desktop never sent the read")
      .toEqual([{ kind: "mark_seen", ids: [id], unread: false, via: "glance" }]);
    expect(store.disk.some((d) => d.startsWith("put ")), "the outbox row never reached the disk").toBe(true);
    expect(rowOf(id).dataset.unseen).toBeUndefined();
    expect(count(), "the count and the row disagree").toBe(before - 1);
  });

  it("a preview passed within the rest writes nothing, however long after", async () => {
    await mountWindow(new LaterTaskDisk());
    const passed = host!.querySelector<HTMLElement>(".row[data-id]")!.dataset.id!;
    expect(rowOf(passed).dataset.unseen, "the first row is not unread").toBe("1");
    const j = () => act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    await j();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    await j(); // on, before the 1.3 s rest
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(wire.filter((w) => w.kind === "mark_seen" && w.ids.includes(passed)), "a passed preview wrote a read").toEqual([]);
    expect(rowOf(passed).dataset.unseen).toBe("1");
  });

  it("a row marked unread stays unread after j away, k back and a long rest; ↵ then reads it (found on 0.30.12)", async () => {
    await mountWindow(new LaterTaskDisk());
    const id = host!.querySelector<HTMLElement>('.row[data-unseen="1"][data-id]')!.dataset.id!;
    const key = (k: string) => act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const marks = () => wire.filter((w) => w.kind === "mark_seen" && w.ids.includes(id)).map((w) => w.unread);
    await act(async () => { rowOf(id).click(); });
    await wait(50);
    await layout.passDwell();
    expect(marks(), "the open reads it").toEqual([false]);
    await key("u");
    await wait(50);
    expect(marks()).toEqual([false, true]);
    await key("j");
    await wait(300);
    await key("k");
    expect(host!.querySelector(".view .row.sel")?.getAttribute("data-id"), "k came back").toBe(id);
    await wait(6000);
    expect(marks(), "the landing's rest read it back").toEqual([false, true]);
    await key("Enter");
    await wait(50);
    await layout.passDwell();
    expect(marks()).toEqual([false, true, false]);
  });

  /**
   * A conversation opens on its newest, also when opened again (the c3 design): the
   * fixture's three unread letters threaded into one row. The first open reads the newest; after
   * another row, the reopen opens the newest again and reads none of the older members, which stay
   * unread (it opened the newest unread and read it).
   */
  it("a reopened conversation lands on its newest and reads nothing it did not show", async () => {
    // The demo world has no threads: three of its unread letters get one, in the world itself.
    type ToMessage = { toMessage: (...a: unknown[]) => { id: string; threadId: string | null } };
    const proto = FixturesAdapter.prototype as unknown as ToMessage;
    const toMessage = proto.toMessage;
    vi.spyOn(proto, "toMessage").mockImplementation(function (this: unknown, ...a: unknown[]) {
      const m = toMessage.apply(this, a);
      return ["giulia", "petra", "ben"].includes(m.id) ? { ...m, threadId: "T" } : m;
    });
    const sync = FixturesAdapter.prototype.sync;
    vi.spyOn(FixturesAdapter.prototype, "sync").mockImplementation(async function (this: FixturesAdapter, params) {
      const page = await sync.call(this, params);
      const creates: SyncChange[] = [...page.changes.creates];
      const lead = creates.find((c) => c.type === "message" && c.id === "giulia");
      if (lead) {
        const m = lead.entity as { accountId: string; subject: string; date: string };
        creates.push({ ...lead, type: "thread", id: "T", entity: {
          id: "T", accountId: m.accountId, rootMessageIdHeader: null, subject: m.subject,
          messageIds: ["ben", "petra", "giulia"], lastMessageAt: m.date, participants: [], updatedAt: lead.updatedAt,
        } });
      }
      return { ...page, changes: { ...page.changes, creates } };
    });
    await mountWindow(new LaterTaskDisk());
    const group = [...host!.querySelectorAll<HTMLElement>('.row[data-unseen="1"][data-ids]')]
      .find((r) => (r.dataset.ids ?? "").split(" ").length >= 2);
    expect(group, "the fixture Ohbox shows no unread conversation").toBeTruthy();
    const newest = group!.dataset.id!;
    const older = group!.dataset.ids!.split(" ").filter((id) => id !== newest);
    const holding = (): HTMLElement => host!.querySelector<HTMLElement>(`.row[data-ids~="${newest}"]`)!;
    const reads = () => wire.filter((w) => w.kind === "mark_seen").flatMap((w) => w.ids);
    const focused = () => host!.querySelector<HTMLElement>('.read-col [data-conv-id][aria-current="true"]')?.dataset.convId
      ?? host!.querySelector<HTMLElement>(".read-col [data-conv-id]")?.dataset.convId;

    await act(async () => { holding().click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await layout.passDwell();
    expect(focused(), "the first open").toBe(newest);
    expect(reads(), "the first open reads the newest").toEqual([newest]);
    const other = [...host!.querySelectorAll<HTMLElement>(".row[data-id]")].find((r) => !(r.dataset.ids ?? r.dataset.id!).split(" ").includes(newest));
    expect(other, "the fixture Ohbox shows one row only").toBeTruthy();
    await act(async () => { other!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const before = reads();

    expect(holding().dataset.id, "the row stands for its newest").toBe(newest);
    await act(async () => { holding().click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await layout.passDwell();
    expect(focused(), "the reopen lands on the newest").toBe(newest);
    expect(reads().slice(before.length).filter((id) => older.includes(id)), "the reopen read an older member unseen").toEqual([]);
  });
});
