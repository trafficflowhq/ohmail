/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOADING_GRACE_MS } from "../app/shell/loading-grace";
import type { MailboxFacts } from "../app/shell/mail-state";
import { ISO, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick } from "./fixtures/live-walk-shell";

/**
 * THE RAIL SAYS NO NUMBER WHILE THE PANES MAY NOT — the same `countWhen` gate.
 *
 * A warm reopen hydrates the mirror, the old drain stamp settles the panes, and the catch-up
 * drain is still in flight. The panes withhold their counts through `countWhen` until the tab's
 * own catch-up completes; the rail's badges and tooltips ("3 unread of 3 messages", "N new since
 * you were here") kept stating the mirror's numbers, which the catch-up was still changing.
 */

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

const railItem = (el: HTMLElement, id: string): HTMLElement => {
  const item = el.querySelector<HTMLElement>(`[data-rail-id="${id}"]`);
  expect(item, `no rail row ${id}`).toBeTruthy();
  return item!;
};
const countOf = (el: HTMLElement, id: string): string =>
  (railItem(el, id).querySelector(".cnt")?.textContent ?? "").trim();

describe("the rail's stream counts mid-catch-up", () => {
  it("withholds the badge and the tooltip until the catch-up lands, then states them", async () => {
    const { HttpAdapter, LAST_DRAIN_AT_META, MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
    const store = new MemoryMirrorStore();
    await store.applyResponse(await page(3).json());
    await store.setMeta(LAST_DRAIN_AT_META, new Date(Date.parse(ISO) - 90 * 60_000).toISOString());

    // Every `/sync` is held until the case releases them all; after that they answer at once.
    const held: Array<() => void> = [];
    let open = false;
    const release = (): void => { open = true; for (const r of held.splice(0)) r(); };
    const empty = (): Response => new Response(JSON.stringify({
      changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c-after", hasMore: false, serverTime: ISO,
    }), { status: 200, headers: { "content-type": "application/json" } });
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "/api",
        fetch: async (url: string) => {
          // The catch-up, held open until the case lets it land.
          if (String(url).includes("/sync")) {
            return open ? empty() : new Promise<Response>((resolve) => { held.push(() => resolve(empty())); });
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
      store,
    });
    const el = await mountShell([mailbox({ lastSyncAt: ISO } as Partial<MailboxFacts>)], { engine });
    await tick(LOADING_GRACE_MS * 4);

    // MUTATION: `mayCount` forced true — the badge reads 3 and the tooltip counts mid-catch-up.
    expect(countOf(el, "ohbox"), "the Ohbox badge counted a mirror still catching up").toBe("");
    // Rows on screen, no number yet: the rail and the header say it is counting, never 0 and never nothing.
    expect(railItem(el, "ohbox").getAttribute("title"), "the Ohbox tooltip counted mid-catch-up").toBe("Counting unread…");
    expect(el.querySelector(".view-ohbox .vhead .meta")?.textContent, "the Ohbox header said nothing over its rows").toBe("Counting unread…");
    expect(railItem(el, "reads").getAttribute("title"), "the News tooltip counted mid-catch-up").toBeNull();

    // The control: the same rail states its numbers once the catch-up has landed.
    expect(held.length, "the catch-up never started").toBeGreaterThan(0);
    release();
    await tick(LOADING_GRACE_MS * 4);
    expect(countOf(el, "ohbox")).toBe("3");
    expect(railItem(el, "ohbox").getAttribute("title")).toContain("3 unread");
    expect(el.querySelector(".view-ohbox .vhead .meta")?.textContent).toBe("3 unread");
  }, 30_000);
});

/**
 * THE SCREENER STRIP AT A START WHOSE MIRROR HOLDS NO QUEUE PAGE — the desktop window, rebuilt at
 * every launch. The mirror holds two strangers' mail at the gate; the store's first queue answer is
 * held open. The strip used to draw the device's own senders ("2 waiting") until the answer came,
 * then drop them.
 */
describe("the Screener strip before the store's first queue answer", () => {
  async function start(listed: boolean, answerAtOnce = false): Promise<{ el: HTMLElement; release: () => void }> {
    const { HttpAdapter, MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
    const store = new MemoryMirrorStore();
    await store.applyResponse(await page(3).json());
    const gate = await page(2, "ohmail/Screener").json() as { changes: { creates: Array<{ entity: { id: string; from: { address: string } } }> } };
    await store.applyResponse(gate as never);
    const items = listed ? gate.changes.creates.map(({ entity: m }) => ({
      messageId: m.id, address: m.from.address, name: null, receivedAt: ISO, subject: "s", snippet: "s", mailboxId: "mb_1",
    })) : [];
    let open = answerAtOnce;
    const held: Array<() => void> = [];
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const queue = (): Response => json({ items, nextCursor: null, total: items.length });
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "/api",
        fetch: async (url: string) => {
          if (String(url).includes("/sync")) {
            return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c-after", hasMore: false, serverTime: ISO });
          }
          if (String(url).includes("/screener?")) {
            return open ? queue() : new Promise<Response>((resolve) => { held.push(() => resolve(queue())); });
          }
          return json({});
        },
      }),
      store,
    });
    const el = await mountShell([mailbox({ lastSyncAt: ISO } as Partial<MailboxFacts>)], { engine });
    await tick(LOADING_GRACE_MS * 4);
    return { el, release: () => { open = true; for (const r of held.splice(0)) r(); } };
  }
  const bell = (el: HTMLElement): string => el.querySelector(".view-ohbox button.doorbell")?.textContent ?? "";
  const meta = (el: HTMLElement): string | undefined => el.querySelector(".view-ohbox .vhead .meta")?.textContent ?? undefined;

  it("claims no waiting sender the store does not hold, before or after its answer", async () => {
    const { el, release } = await start(false);
    expect(bell(el), "the strip counted the device's own senders before the store answered").not.toContain("waiting");
    expect(countOf(el, "screener"), "the rail counted them").toBe("");
    release();
    await tick(LOADING_GRACE_MS * 4);
    expect(bell(el)).not.toContain("waiting");
    expect(bell(el), "the strip never came back once the store answered").toContain("All clear");
  }, 30_000);

  it("CONTROL: senders the store lists are drawn the moment it answers", async () => {
    const { el, release } = await start(true);
    release();
    await tick(LOADING_GRACE_MS * 4);
    expect(bell(el)).toContain("2 waiting");
    expect(countOf(el, "screener")).toBe("2");
  }, 30_000);

  // The gate mail of senders the store does not list joins the Ohbox once it answers: 3 became 5.
  it("states the Ohbox's unread count once, after the store's answer", async () => {
    const { el, release } = await start(false);
    expect(meta(el), "the Ohbox header counted before the store answered").toBe("Counting unread…");
    expect(countOf(el, "ohbox"), "the rail's Ohbox badge counted before the store answered").toBe("");
    release();
    await tick(LOADING_GRACE_MS * 4);
    expect(meta(el)).toBe("5 unread");
    expect(countOf(el, "ohbox")).toBe("5");
  }, 30_000);

  /* A /sync cursor refused with 410 after the store's answer: the wipe took the queue page, and each
     rebuilt page of gate mail used to count as the queue ("6 waiting", then 7, 8) until the rebuild settled. */
  it("states no other count while a 410 rebuild refills the mirror, then the store's again", async () => {
    const { HttpAdapter, MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
    const gate = await page(8, "ohmail/Screener").json() as {
      cursor: string; changes: { creates: Array<{ entity: { id: string; from: { address: string } } }> };
    };
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const part = (from: number, to: number, hasMore: boolean): Response => json({
      changes: { creates: gate.changes.creates.slice(from, to), updates: [], moves: [], deletes: [] },
      cursor: `${gate.cursor}-${to}`, hasMore, serverTime: ISO,
    });
    const items = gate.changes.creates.slice(0, 2).map(({ entity: m }) => ({
      messageId: m.id, address: m.from.address, name: null, receivedAt: ISO, subject: "s", snippet: "s", mailboxId: "mb_1",
    }));
    const syncs: Array<() => Response | Promise<Response>> = [() => part(0, 8, false)];
    let lastPage!: () => void;
    let holdQueue = false;
    const heldQueue: Array<() => void> = [];
    const queue = (): Response => json({ items, nextCursor: null, total: 2 });
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "/api",
        fetch: async (url: string) => {
          if (String(url).includes("/sync?")) {
            return (syncs.shift() ?? (() => json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c-idle", hasMore: false, serverTime: ISO })))();
          }
          if (String(url).includes("/screener?")) {
            return holdQueue ? new Promise<Response>((resolve) => { heldQueue.push(() => resolve(queue())); }) : queue();
          }
          return json({});
        },
      }),
      store: new MemoryMirrorStore(),
    });
    const el = await mountShell([mailbox({ lastSyncAt: ISO } as Partial<MailboxFacts>)], { engine });
    await tick(LOADING_GRACE_MS * 4);
    expect(bell(el)).toContain("2 waiting");
    expect(countOf(el, "screener")).toBe("2");

    const said = new Set<string>();
    const note = (): void => {
      const n = bell(el).includes("waiting") ? el.querySelector(".view-ohbox button.doorbell b")?.textContent : null;
      said.add(`strip:${n ?? "-"}`);
      said.add(`rail:${countOf(el, "screener") || "-"}`);
    };
    const watch = new MutationObserver(note);
    watch.observe(el, { subtree: true, childList: true, characterData: true });
    holdQueue = true;
    syncs.push(
      () => json({ error: "cursor_expired" }, 410),
      () => part(0, 6, true),
      () => new Promise<Response>((resolve) => { lastPage = () => resolve(part(6, 8, false)); }),
    );
    void engine.syncOnce();
    await tick(LOADING_GRACE_MS * 4);
    note();
    expect(lastPage, "the rebuild never reached its last page").toBeTypeOf("function");
    lastPage();
    await tick(LOADING_GRACE_MS * 4);
    holdQueue = false;
    for (const r of heldQueue.splice(0)) r();
    await tick(LOADING_GRACE_MS * 4);
    note();
    watch.disconnect();
    expect([...said].filter((s) => !/:(2|-)$/.test(s)), "a count the store never stated").toEqual([]);
    expect(bell(el)).toContain("2 waiting");
    expect(countOf(el, "screener")).toBe("2");
  }, 30_000);

  it("CONTROL: a store that answers at once delays the Ohbox's count no further", async () => {
    const { el } = await start(false, true);
    expect(meta(el)).toBe("5 unread");
    expect(countOf(el, "ohbox")).toBe("5");
  }, 30_000);
});
