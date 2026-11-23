/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UnscreenedPileWire } from "@ohmail/wire";
import { createEngine } from "../app/shell/engine-config.js";
import { NOW, act, message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";
import * as live from "./fixtures/live-walk-shell.js";

const date = (i: number) => new Date(NOW.getTime() - i * 60_000).toISOString();
const letters = [
  ...["news-1", "news-2"].map((id, i) =>
    message(id, { folder: "ohmail/News", date: date(i), unread: true })),
  ...["receipt-1", "receipt-2", "receipt-3"].map((id, i) =>
    message(id, { folder: "ohmail/Receipts", date: date(i), unread: true })),
];
const exposed = (el: HTMLElement, name: string) => within(el).queryByRole("region", { name });
const rows = (el: HTMLElement, pile: string) => within(within(el).getByRole("region", { name: pile })).getAllByRole("option");
const selected = (el: HTMLElement, pile: string) => rows(el, pile).find((r) => r.getAttribute("aria-selected") === "true");

const go = (path: string) => act(async () => {
  window.location.hash = path;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});

describe("the piles among the piles", () => {
  beforeEach(() => stubDom());
  afterEach(unmountAll);

  it("revisiting a stream shows its own letters and leaving removes the stream pane", async () => {
    const { el } = await mountShell("#/reads", letters);
    expect(exposed(el, "News stream")).not.toBeNull();
    expect(rows(el, "News").map((r) => r.dataset.id)).toEqual(["news-1", "news-2"]);
    await go("#/receipts");
    expect(exposed(el, "News stream")).toBeNull();
    expect(exposed(el, "Receipts stream")).not.toBeNull();
    expect(rows(el, "Receipts").map((r) => r.dataset.id)).toEqual(["receipt-1", "receipt-2", "receipt-3"]);
    await go("#/drafts");
    expect(exposed(el, "News stream")).toBeNull();
    expect(exposed(el, "Receipts stream")).toBeNull();
    await go("#/reads");
    expect(exposed(el, "News stream")).not.toBeNull();
    expect(rows(el, "News").map((r) => r.dataset.id)).toEqual(["news-1", "news-2"]);
  });

  it("on Receipts after News, focus follows the cursor into Receipts' own rows", async () => {
    const { el } = await mountShell("#/reads", letters);
    await act(async () => { fireEvent.click(rows(el, "News")[0]!); });
    await go(window.location.hash);
    expect(selected(el, "News")?.dataset.id).toBe("news-1");
    await go("#/receipts");
    const available = rows(el, "Receipts");
    expect(available.length).toBeGreaterThan(2);
    await act(async () => { fireEvent.click(available[0]!); });
    await go(window.location.hash);
    await act(async () => { selected(el, "Receipts")!.focus(); });
    const press = async (key: string) => {
      await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key }); });
      await go(window.location.hash);
    };
    await press("j");
    const current = selected(el, "Receipts");
    expect(current?.dataset.id).toBe(available[1]!.dataset.id);
    expect(document.activeElement).toBe(current);
    await press("ArrowLeft");
    expect(document.activeElement?.closest("nav[aria-label='Places']")).not.toBeNull();
    await press("ArrowRight");
    expect(document.activeElement).toBe(current);
  });

  it("after a switch the pane says the rail's number, a change made while it was hidden included", async () => {
    const { el, engine } = await mountShell("#/reads", letters);
    const railCount = () => {
      const rail = within(within(el).getByRole("navigation", { name: "Places" }));
      const entry = rail.getByRole("button", { name: /^News(?: \d+)?$/ });
      return Number(/\d+$/.exec(entry.getAttribute("aria-label") ?? "")?.[0] ?? 0);
    };
    const count = () => within(within(el).getByRole("region", { name: "News" })).getByText(/since you were here/).textContent;
    const before = count();
    expect(before).toBe(`${railCount()} new since you were here`);
    expect(railCount()).toBe(2);
    await go("#/receipts");
    await act(async () => {
      await engine.mutate({ kind: "mark_seen", messageIds: ["news-1", "news-2"], unread: false, via: "glance" });
    });
    await go("#/reads");
    expect(count()).toBe("Nothing new since you were here");
    expect(railCount()).toBe(0);
    expect(engine.read().get<{ unread: boolean }>("message", "news-1")?.unread).toBe(false);
    expect(engine.read().get<{ unread: boolean }>("message", "news-2")?.unread).toBe(false);
    expect(count()).not.toBe(before);
  });
});

describe("each pile's note on senders nobody let in", () => {
  beforeEach(live.installShellEnv);
  afterEach(live.teardownShellEnv);

  it("News and Receipts each ask their own pile when shown, and the press sends it", async () => {
    const asks: UnscreenedPileWire[] = [];
    const writes: UnscreenedPileWire[] = [];
    const left: Record<UnscreenedPileWire, number> = { news: 2, receipts: 1 };
    const fixture = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "https://fixture.invalid");
      if (url.pathname !== "/api/screener/unscreened") return fixture(input, init);
      if (init?.method === "POST") {
        const { pile } = JSON.parse(String(init.body)) as { pile: UnscreenedPileWire };
        writes.push(pile);
        const total = left[pile];
        left[pile] = 0;
        return Response.json({ screened: [], total });
      }
      const pile = url.searchParams.get("pile");
      if (pile !== "news" && pile !== "receipts") return Response.json({ groups: [], total: 0, complete: true, max: 200 });
      asks.push(pile);
      return Response.json({
        groups: left[pile] ? [{ address: "vendor@example.test", count: left[pile], newestAt: live.ISO }] : [],
        total: left[pile], complete: true, max: 200, pile,
      });
    };
    const el = await live.mountShell([live.mailbox({ lastSyncAt: live.ISO })], {
      engine: createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" }),
    });
    const note = () => within(el).queryAllByRole("note").find((n) =>
      n.textContent?.includes("you haven't screened yet"),
    ) ?? null;
    await live.tick(30_000);
    expect(asks).toEqual([]);
    expect(note()).toBeNull();

    await live.goTo("reads");
    await live.tick(1_000);
    expect(asks).toEqual(["news"]);
    expect(note()?.querySelector("b")?.textContent).toBe("2 letters in News come from senders you haven't screened yet");
    expect(note()?.textContent).toContain("Screen sends them to the Screener, where you decide once per sender. Nothing is deleted.");
    await live.goTo("receipts");
    await live.tick(1_000);
    expect(asks).toEqual(["news", "receipts"]);
    expect(note()?.querySelector("b")?.textContent).toBe("1 letter in Receipts comes from a sender you haven't screened yet");
    expect(note()?.textContent).toContain("Screen sends them to the Screener, where you decide once per sender. Nothing is deleted.");
    expect(writes).toEqual([]);

    await live.act(async () => { within(note()!).getByRole("button", { name: /screen 1/i }).click(); });
    await live.tick(50);
    expect(writes).toEqual(["receipts"]);
    expect(note(), "the note outlived the press it answered").toBeNull();
    await live.goTo("reads");
    await live.tick(1_000);
    expect(note()?.querySelector("b")?.textContent).toBe("2 letters in News come from senders you haven't screened yet");
    expect(note()?.textContent).toContain("Screen sends them to the Screener, where you decide once per sender. Nothing is deleted.");
    expect(writes).toEqual(["receipts"]);
  });
});
