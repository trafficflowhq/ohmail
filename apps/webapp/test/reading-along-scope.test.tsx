/** @vitest-environment jsdom */
/**
 * READING ALONG ON PURPOSE IS RECORDED AND OBEYED UNDER THE SCOPE THE SHELL HANDS IN: a person who chose to read along
 * here silenced the filing sentence for their own account, and another account's choice on the same browser neither
 * silences theirs nor is silenced by it, whatever the storage owner says while the shell stands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import { readingAlong, readingAlongKey, setReadingAlong } from "@ohmail/app-logic/reading/reading-along";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../messages/en.json";
import { act, consentTransport, engineOver, msg, NOW, S, setup, storeWith, teardown } from "./_view-shell.js";

const A = "acc-A1";
const B = "acc-B2";
const WHO = { kind: "local", name: "omarchy", stopped: false, mailboxId: "mbx-1", since: "2026-09-01T00:00:00.000Z" };
const SAYING = (messages.sync as Record<string, string>).filingElsewhereLocalHow!
  .replace("{name}", "omarchy")
  .replace(/\.$/, "");

/** The mailbox's filing is held by another install: the state the strip words as the holder's sentence. */
const HELD_ELSEWHERE = {
  key: "filing", clock: false, count: 2, total: null, reason: null, errorCode: null, asOf: null,
  address: "someone@example.com", minutes: null, slow: false, screenerCandidate: false, pending: 2,
  filing: {
    arm: "elsewhere", count: 2, deferred: 0, reason: null, nextAttemptAt: null, waitedMinutes: null,
    lastPassSeconds: null, who: WHO, asOf: null, mailboxes: 1, first: null, reasonsDiffer: false,
  },
  continuesAtFolder: null, settled: true, owed: false,
} as unknown as MailState;

/* The shell's own binding, with the filing state this file is about put in its place. */
let held: MailState | null = null;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/app-logic/mail-state/mail-state-binding")>();
  return {
    ...real,
    useMailState: () => {
      const binding = real.useMailState();
      return held === null ? binding : { ...binding, state: held };
    },
  };
});

/** Today's views through the harness, handed `scope` by their host (absent: the storage owner the test named). */
async function shellUnder(scope: string | undefined): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const store = await storeWith([msg("m1")]);
  const engine = engineOver(store);
  S.store = store;
  S.engine = engine;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: React.createElement(ThemeProvider, { children: React.createElement(ToastHost, {
        children: React.createElement(AppShell as never, {
          ...(scope === undefined ? {} : { scope }), demo: false, engine, consentTransport, mailboxFacts: async () => [],
        } as never),
      }) }),
    } as never));
  });
  for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  return container;
}

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  held = null;
});
afterEach(async () => {
  held = null;
  await teardown();
  resetStorageOwnerForTest();
  window.localStorage.clear();
});

describe("reading along is kept and read under the scope handed in", () => {
  it("records a choice made under A while the storage owner names B as A's, and B reads nothing", () => {
    setStorageOwner(B);
    setReadingAlong("mbx-1", WHO, A);
    expect({
      keptForA: window.localStorage.getItem(readingAlongKey(A)) !== null,
      keptForB: window.localStorage.getItem(readingAlongKey(B)),
      readByA: readingAlong("mbx-1", WHO, A),
      readByB: readingAlong("mbx-1", WHO, B),
    }).toEqual({ keptForA: true, keptForB: null, readByA: true, readByB: false });
  });

  it("through the shell, the filing sentence keeps obeying the shell's own record after the storage owner moved", async () => {
    setStorageOwner(A);
    setReadingAlong("mbx-1", WHO, A);
    held = HELD_ELSEWHERE;
    const el = await shellUnder(undefined);
    expect(el.textContent ?? "", "A's shell said the sentence A chose to silence").not.toContain(SAYING);
    /* Another tab signs in as B: the storage owner moves while A's views stand, and they are drawn again. */
    setStorageOwner(B);
    window.location.hash = "#/history";
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(el.textContent ?? "", "A's shell took B's (empty) record once the storage owner moved").not.toContain(SAYING);
  });

  it("through the shell, the filing sentence obeys the record of the scope its host hands, not the storage owner's", async () => {
    setReadingAlong("mbx-1", WHO, A);
    setStorageOwner(B);
    held = HELD_ELSEWHERE;
    /* The control first: a shell whose host hands B, whose account chose nothing, says the holder's sentence. */
    const ofB = await shellUnder(B);
    expect(ofB.textContent ?? "", "the shell of an account that chose nothing said nothing").toContain(SAYING);
    for (const root of S.roots.splice(0)) await act(async () => { root.unmount(); });
    document.body.innerHTML = "";
    const ofA = await shellUnder(A);
    expect(ofA.textContent ?? "", "A's shell said the sentence A chose to silence").not.toContain(SAYING);
  });
});
