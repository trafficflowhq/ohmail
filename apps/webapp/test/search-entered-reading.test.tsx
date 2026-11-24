/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ISO, act, answerConsentWith, goTo, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { click, mountThread, msg, patches, settle } from "./fixtures/thread-read-shell.js";
import { letterShown, ohboxRow } from "./ohbox/_finders.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

const sheet = () => document.querySelector('[role="dialog"][aria-label="Reading"]');

beforeEach(installShellEnv);
afterEach(async () => {
  await teardownShellEnv();
  vi.unstubAllGlobals();
});

describe("a hit opened from Search reads in its column and in the sheet", () => {
  let layout: ThreadLayout;
  beforeEach(() => { layout = stubThreadLayout(); });
  afterEach(() => { layout.restore(); });
  const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
  const dwell = async (): Promise<void> => { await layout.passDwell(); await settle(); };
  const folder = { type: "folder", op: "create", id: "fd1", seq: 901, updatedAt: ISO, entity: { id: "fd1", name: "Projects", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO } };
  const kettle = (over: Record<string, unknown>) => msg("k1", 20, { threadId: "t-k1", subject: "Harbour kettle", ...over });
  const hit = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="listitem"][data-hit="k1"] [role="button"]');
  async function search(found: unknown): Promise<HTMLInputElement> {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!/\/search\?/.test(String(input))) return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
      return new Response(JSON.stringify({ items: [found], total: 1, totalExact: true, ms: 4 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    await goTo("search");
    const box = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(box, "harbour"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await tick(1_000);
    await settle();
    expect(hit(), "the hit").not.toBeNull();
    return box;
  }
  const entity = (m: unknown) => (m as { entity: unknown }).entity;

  it("Return on a hit filed in Answer Later: the sheet opens it and reads it", async () => {
    vi.stubGlobal("innerWidth", 390);
    const k1 = kettle({ triage: { id: "ms_k1", messageId: "k1", state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO } });
    await mountThread([k1]);
    const box = await search(entity(k1));
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await settle();
    expect(sheet()?.querySelector('[data-conv-id="k1"]') ?? null, "the sheet shows it").not.toBeNull();
    expect(patches, "nothing before the dwell").toEqual([]);
    await dwell();
    await dwell();
    expect(glances()).toEqual([["k1"]]);
  }, 60_000);

  it("a click on a hit in a folder: Search's column reads it", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    const k1 = kettle({ folder: "Projects" });
    await mountThread([k1, msg("k0", 30, { threadId: "t-k0", folder: "Projects" }), folder]);
    await search(entity(k1));
    await click(hit(), "the hit");
    expect(window.location.hash).toBe("#/search/m/k1?q=harbour");
    expect(letterShown(document, "k1"), "the column shows it").not.toBeNull();
    await dwell();
    await dwell();
    expect(glances()).toEqual([["k1"]]);
  }, 60_000);

  it("the same letter by link reads nothing", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    window.location.hash = "#/folder/fd1/m/k1";
    await mountThread([kettle({ folder: "Projects" }), msg("k0", 30, { threadId: "t-k0", folder: "Projects" }), folder]);
    expect(letterShown(document, "k1"), "the link opened it").not.toBeNull();
    await dwell();
    await dwell();
    expect(patches).toEqual([]);
  }, 60_000);
});

it("keeps the shared conversation squares and each letter's own dwell in a tag", async () => {
  const layout = stubThreadLayout();
  try {
    const tag = {
      type: "tag", op: "create", id: "plans", seq: 900, updatedAt: ISO,
      entity: { id: "plans", name: "Plans", hue: "blue", createdAt: ISO, updatedAt: ISO },
    };
    window.location.hash = "#/tag/plans";
    await mountThread([
      msg("p1", 0, { labels: ["plans"] }),
      msg("p2", 10, { labels: ["plans"] }),
      msg("p3", 20, { labels: ["plans"] }),
      tag,
    ]);
    const dwell = async () => { await layout.passDwell(); await settle(); };
    const glances = () => patches.filter((patch) => patch.via === "glance").map((patch) => patch.ids);
    await click(ohboxRow(document, "p3"), "the newest tagged letter");
    await dwell();
    expect(glances()).toEqual([["p3"]]);

    await layout.handScroll(layout.topOf("p1") - 10);
    await settle();
    await layout.handScroll(layout.topOf("p3") - 14);
    await settle();
    await dwell();
    expect(glances()).toEqual([["p3"]]);

    await layout.handScroll(layout.topOf("p2") - 10);
    await settle();
    await dwell();
    expect(glances()).toEqual([["p3"], ["p2"]]);
    const unread = letterShown(document, "p1");
    expect(unread?.querySelector("[data-unread]")).toBeNull();
    expect(unread?.querySelector(".oh-avatar .oh-dot")).toBeTruthy();
    expect(screen.getByRole("group", { name: /^3 messages, / })).toBeTruthy();
  } finally {
    layout.restore();
  }
}, 30_000);
