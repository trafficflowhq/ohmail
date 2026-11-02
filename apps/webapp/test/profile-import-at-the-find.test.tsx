/** @vitest-environment jsdom */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * THE FOUND-SETTINGS CARD SHOWS AT THE FIND, through the shipped shell and its real engine.
 *
 * Measured on 0.25.1: the card appeared 8 min 25 s after the engine found another install's
 * document — the hook's second five-minute beat — while the routing and the write waited on the
 * answer. The organizer's marker now rings the `settings` doorbell (`profile.ts#writeMarker`), the
 * row drains like any other, and the shell re-asks on the drain that carries it. The poll cadence
 * here is the engine's own (30 s); the beat stays 5 min and is never reached.
 */

const MB_ID = "mb_1";
const FOUND = {
  state: "found", fingerprint: "b".repeat(64), updatedAt: "2026-08-04T08:00:00.000Z",
  producer: { kind: "local", version: "0.25.1" },
  counts: { screener: 3, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
};
const EPOCH = new Date(0).toISOString();

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** The account's settings, unchanged — exactly what the doorbell row re-materializes. */
const doorbellRow = (seq: number) => ({
  type: "settings", op: "update", id: "acct_live_1", seq, updatedAt: EPOCH,
  entity: {
    accountId: "acct_live_1", dormancyDays: null, autoSuggestAt: null, blockRemoteImagesAt: null,
    loadTrackingPixelsAt: null, blockAutoUnsubscribeAt: null, foldersEnabledAt: null,
    folderMailboxesOff: {}, locale: null, updatedAt: EPOCH,
  },
});

/** What the server's candidate door answers now, and every ask it took. */
let question: Record<string, unknown>;
let asks: number;
let declines: number;
/** Set to ring: the next `/sync` page carries one doorbell row. */
let ringNext: boolean;
let seq: number;

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  question = { state: "none" };
  asks = 0;
  declines = 0;
  ringNext = false;
  seq = 100;
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(`/mailboxes/${MB_ID}/profile-import`)) {
      if (url.endsWith("/decline")) {
        declines += 1;
        question = { state: "none" };
        return json({ dismissed: true });
      }
      if ((init?.method ?? "GET") === "GET") {
        asks += 1;
        return json(question);
      }
    }
    return inner(input as RequestInfo, init);
  }) as unknown as typeof fetch;
  answerSyncWith(() => {
    const creates = ringNext ? [doorbellRow(++seq)] : [];
    ringNext = false;
    return json({
      changes: { creates, updates: [], moves: [], deletes: [] },
      cursor: `c${++seq}`, hasMore: false, serverTime: "2026-08-04T09:00:00.000Z",
    });
  });
});
afterEach(async () => {
  await teardownShellEnv();
});

const card = (el: HTMLElement): HTMLElement | null => el.querySelector(".pfi-card");

/** The shell, booted and settled, with the mailbox's first answer (`none`) already taken. */
async function booted(stageCard?: React.ReactNode): Promise<HTMLElement> {
  const el = await mountShell([mailbox({ id: MB_ID })], stageCard === undefined ? {} : { stageCard });
  await tick(60_000);
  expect(asks, "the shell never asked about the mailbox — the fixture is broken").toBeGreaterThan(0);
  expect(card(el)).toBeNull();
  return el;
}

/* The first mount pays the whole shell's import; under a parallel run that outlasts the default 5 s. */
describe("the found-settings card is asked for on the drain that carries the find", { timeout: 30_000 }, () => {
  it("the find at t0 ⇒ the card one drain later, not at the five-minute beat", async () => {
    const el = await booted();
    // t0: the organizer finds the document, records its marker and rings the doorbell.
    question = FOUND;
    ringNext = true;
    await tick(30_000);
    expect(card(el), "the card waited for the beat after the find had drained").not.toBeNull();
    expect(textOf(card(el)!)).toContain("We found your ohmail settings on this mailbox");
  });

  /* IN THE FLOW, ONE CARD AT A TIME: the stage's slot holds the found-settings card before the view, and a
     host's card (the desktop's default-mail ask) waits behind it, back once the question is answered. */
  it("the card stands in the stage's slot before the view; a host's card waits behind it", async () => {
    const el = await booted(React.createElement("p", { className: "host-card" }, "Open email links with ohmail?"));
    const slot = (): Element | null => el.querySelector("main.stage > .stage-notice:first-child");
    const before = slot()?.querySelector(".host-card") !== null;
    question = FOUND;
    ringNext = true;
    await tick(30_000);
    const asked = { card: card(el)?.parentElement === slot(), host: el.querySelector(".host-card") !== null, view: slot()?.nextElementSibling !== null };
    const notNow = [...card(el)!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Not now");
    await act(async () => { notNow!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(0);
    expect({ before, asked, after: slot()?.querySelector(".host-card") !== null && card(el) === null })
      .toEqual({ before: true, asked: { card: true, host: false, view: true }, after: true });
  });

  it("no ring ⇒ no extra ask: nothing polls tighter than the beat", async () => {
    const el = await booted();
    const before = asks;
    // A server that records the find and rings nothing (an older build): three drains pass.
    question = FOUND;
    await tick(90_000);
    expect(asks, "a drain without the doorbell re-asked the question").toBe(before);
    expect(card(el)).toBeNull();
  });

  it("a card answered Not now stays gone when the next ring re-asks", async () => {
    const el = await booted();
    question = FOUND;
    ringNext = true;
    await tick(30_000);
    const offered = card(el);
    expect(offered).not.toBeNull();
    const notNow = [...offered!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Not now");
    expect(notNow, "the card carries no Not now").toBeTruthy();
    await act(async () => { notNow!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(0);
    expect(declines).toBe(1);
    expect(card(el)).toBeNull();
    // The organizer's next fact (the answered question's lapse) rings again: the re-ask answers
    // `none` and the card stays gone.
    const before = asks;
    ringNext = true;
    await tick(30_000);
    expect(asks, "the second ring did not re-ask").toBeGreaterThan(before);
    expect(card(el), "a dismissed card came back on the next ring").toBeNull();
  });
});
