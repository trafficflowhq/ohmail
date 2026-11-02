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
