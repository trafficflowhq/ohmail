/** @vitest-environment jsdom */
/**
 * A RE-PAIR MOUNTS THE PAIRED PAGE'S FRAME AGAIN. A letter is begun under pairing 1; a fresh redeem in this tab (or
 * another tab's, which this one adopts at its next rotation) mints pairing 2's scope. The real gate, over the real
 * frame and today's views: pairing 2's composer is empty, and nothing sent under pairing 2 carries pairing 1's words.
 * What holds it: the gate keys its engine provider by the pairing's scope, and the frame keys everything under it by
 * the scope the gate names in the host contract. Seen red with both taken away (the provider unkeyed and one fixed
 * scope handed to the contract): pairing 1's words stand in pairing 2's composer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { fireEvent } from "@testing-library/react";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";

import messages from "../../webapp/messages/en.json";
import { BearerManager, PAIR_SCOPE_STORAGE_KEY } from "../../paired-page/src/bearer.js";
import { HostGate } from "../../paired-page/src/HostGate.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const WORDS = "Half a letter under the first pairing";
let root: Root | null = null;
let el: HTMLDivElement | null = null;
/** Every request the page made, with the pairing that stood when it left. */
let sent: Array<{ scope: string | null; url: string; body: string }> = [];

/** An empty mailbox: the sync's page shape for a sync read, an empty list for the rest. */
const EMPTY_PAGE = { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00.000Z" };
function answer(url: string): Response {
  const body = url.startsWith("/auth/refresh") ? { accessToken: "a2", refreshToken: "r2" }
    : url.includes("sync") ? EMPTY_PAGE : { mailboxes: [], items: [], nextCursor: null };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function draw(bearer: BearerManager): Promise<void> {
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" } as never,
    h(ThemeProvider as never, null, h(ToastHost as never, null, h(HostGate, { bearer }))));
  if (root === null) {
    el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
  }
  await act(async () => { root!.render(tree); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ok()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  throw new Error(`never: ${what}`);
}

const subject = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('input[aria-label="Subject"]');

beforeEach(() => {
  sent = [];
  window.localStorage.clear();
  resetStorageOwnerForTest();
  window.history.replaceState(null, "", "/#/compose");
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("the page opened a socket of its own");
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
  el = null;
  resetStorageOwnerForTest();
});

describe("a re-pair on the paired page", () => {
  it("mounts the frame again: the new pairing's composer is empty and nothing it sends carries the old pairing's words", async () => {
    let bearer: BearerManager | null = null;
    bearer = new BearerManager({
      storage: window.localStorage,
      fetchImpl: (async (url: string, init?: { body?: unknown }) => {
        sent.push({ scope: bearer!.pairScope(), url, body: typeof init?.body === "string" ? init.body : "" });
        return answer(url);
      }) as never,
    });
    bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
    const first = bearer.pairScope();
    expect(first).not.toBeNull();

    await draw(bearer);
    await until(() => subject() !== null, "the composer under the first pairing");
    await act(async () => { fireEvent.change(subject()!, { target: { value: WORDS } }); });
    await until(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes(WORDS)), "the words kept on this device");

    /* A fresh redeem: a new credential and a new scope, the page rendered again. */
    bearer.adopt({ accessToken: "b1", refreshToken: "s1" }, { fresh: true });
    const second = bearer.pairScope();
    expect(second).not.toBe(first);
    await draw(bearer);
    await until(() => subject() !== null, "the composer under the second pairing");
    expect(subject()!.value, "the first pairing's words stand in the second pairing's composer").toBe("");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sent.filter((s) => s.scope === second && s.body.includes(WORDS))).toEqual([]);
  });
});

/**
 * A PAIRING WHOSE SCOPE IS GONE MOUNTS NO MAIL, AND ITS LANDING SAYS ONLY TO SCAN THE CODE. The token stays and the
 * stored scope does not: another tab's sign-out or death removed it, or this browser never kept it. The pairing landing
 * stands in the frame's place with its scan sentence: it reads no code from a mail view's address, asks the computer
 * nothing and leaves the address alone. Nothing is written under the key space that names nobody (`…local`).
 */
describe("a pairing with no scope", () => {
  const words = (messages as unknown as { pairLanding: Record<string, string> }).pairLanding;
  const headings = (): string[] => [...document.querySelectorAll("h1")].map((n) => n.textContent ?? "");
  const frame = (): boolean => document.querySelector(".fr-frame") !== null;
  const namesNobody = (): string[] => Object.keys(localStorage).filter((k) => /\.local(\.|$)/.test(k));
  const address = (): string => `${window.location.pathname}${window.location.hash}`;
  const json = { "content-type": "application/json" };
  /** What the page asks its computer outside the session (the landing's redeem), answered as the case says. */
  let redeems: string[] = [];
  const computerAnswersARedeem = (answerIt: () => Response): void => {
    redeems = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: unknown }) => {
      if (!String(url).includes("/pair/redeem")) throw new Error("the page opened a socket of its own");
      redeems.push(typeof init?.body === "string" ? init.body : "");
      return answerIt();
    }) as never;
  };
  const managerOn = (storage: Storage): BearerManager => {
    let bearer: BearerManager | null = null;
    bearer = new BearerManager({
      storage,
      fetchImpl: (async (url: string, init?: { body?: unknown }) => {
        sent.push({ scope: bearer!.pairScope(), url, body: typeof init?.body === "string" ? init.body : "" });
        return answer(url);
      }) as never,
    });
    return bearer;
  };

  it("says only to scan the code when the stored scope is removed while the token stays: no code is read from the address, and nothing is kept under no scope", async () => {
    computerAnswersARedeem(() => new Response(JSON.stringify({ error: { code: "pairing_invalid", message: "no such code" } }), { status: 400, headers: json }));
    const bearer = managerOn(window.localStorage);
    bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
    await draw(bearer);
    await until(() => subject() !== null, "the composer under the pairing");
    /* Another tab ends the pairing's scope; this tab's token is still held. */
    localStorage.removeItem(PAIR_SCOPE_STORAGE_KEY);
    expect(bearer.paired() && bearer.pairScope() === null, "a pairing with no scope").toBe(true);
    await draw(bearer);
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    if (subject() !== null) {
      /* What the frame mounted again under no scope would keep: a typed letter. */
      await act(async () => { fireEvent.change(subject()!, { target: { value: "Words under no scope" } }); });
      await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    }
    expect({ headings: headings(), frame: frame(), composer: subject() !== null, local: namesNobody(), redeems, address: address() }).toEqual({
      headings: [words.missingTitle], frame: false, composer: false, local: [], redeems: [], address: "/#/compose",
    });
  });

  it("says only to scan the code after a code is scanned in a browser that refuses to keep the pairing's scope", async () => {
    computerAnswersARedeem(() => new Response(JSON.stringify({ tokens: { accessToken: "a9", refreshToken: "r9" } }), { status: 200, headers: json }));
    const refusing: Storage = {
      get length() { return localStorage.length; },
      key: (i: number) => localStorage.key(i),
      getItem: (k: string) => localStorage.getItem(k),
      setItem: (k: string, v: string) => {
        if (k === PAIR_SCOPE_STORAGE_KEY) throw new DOMException("refused", "QuotaExceededError");
        localStorage.setItem(k, v);
      },
      removeItem: (k: string) => localStorage.removeItem(k),
      clear: () => localStorage.clear(),
    };
    const bearer = managerOn(refusing);
    window.history.replaceState(null, "", "/pair#THE-SCANNED-CODE");
    await draw(bearer);
    await until(() => bearer.paired(), "the pairing the computer minted");
    expect(bearer.pairScope(), "a pairing whose scope was never kept").toBeNull();
    /* Read twice: the landing that redeemed must not stay on its "Pairing this device" for good. */
    const seen: string[][] = [];
    for (const ms of [50, 1000]) {
      await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
      seen.push(headings());
    }
    expect({ seen, frame: frame(), composer: subject() !== null, local: namesNobody(), redeemed: redeems.length, mailAsked: sent.length }).toEqual({
      seen: [[words.missingTitle], [words.missingTitle]], frame: false, composer: false, local: [], redeemed: 1, mailAsked: 0,
    });
  });

  it("another tab pairs anew while this tab stands on the first pairing: the landing stands, this tab asks nothing more, and nothing is kept under the new pairing", async () => {
    computerAnswersARedeem(() => new Response(JSON.stringify({ error: { code: "pairing_invalid", message: "no such code" } }), { status: 400, headers: json }));
    const bearer = managerOn(window.localStorage);
    bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
    const first = bearer.pairScope()!;
    await draw(bearer);
    await until(() => subject() !== null, "the composer under the first pairing");
    await act(async () => { fireEvent.change(subject()!, { target: { value: "Words under the first pairing" } }); });
    /* The other tab's redeem: a new token and a new scope in the jar. This tab's manager still holds the first pair. */
    const second = "11111111-2222-4333-8444-555555555555";
    localStorage.setItem("ohmail.host.refreshToken", "other-tab-refresh");
    localStorage.setItem(PAIR_SCOPE_STORAGE_KEY, second);
    const before = sent.length;
    await draw(bearer);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    if (subject() !== null) {
      /* What a frame mounted under the other pairing's scope would keep and ask with this tab's token. */
      await act(async () => { fireEvent.change(subject()!, { target: { value: "Typed after the other tab's pairing" } }); });
      await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
    }
    const firstWords = Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes("Words under the first pairing"));
    expect({
      headings: headings(), frame: frame(), composer: subject() !== null,
      askedAfter: [...new Set(sent.slice(before).map((s) => s.url.split("?")[0]))],
      redeems,
      underTheNewPairing: Object.keys(localStorage).filter((k) => k.includes(second)),
      firstWordsKept: firstWords.length > 0, underTheFirst: firstWords.every((k) => k.includes(first)),
    }).toEqual({
      headings: [words.missingTitle], frame: false, composer: false,
      askedAfter: [], redeems: [], underTheNewPairing: [], firstWordsKept: true, underTheFirst: true,
    });
  });

  it("a page loaded over a stored scope that names nobody shows the landing with its scan sentence: never a blank page, and no code is read", async () => {
    computerAnswersARedeem(() => new Response(JSON.stringify({ error: { code: "pairing_invalid", message: "no such code" } }), { status: 400, headers: json }));
    /* A page load: the jar holds a token and, as the pairing's scope, the word a key spells for nobody. The manager
       takes both as it starts, so the scope it hands is that word and not null. */
    localStorage.setItem("ohmail.host.refreshToken", "r1");
    localStorage.setItem(PAIR_SCOPE_STORAGE_KEY, "local");
    const bearer = managerOn(window.localStorage);
    await draw(bearer);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect({ headings: headings(), frame: frame(), blank: (el?.textContent ?? "").trim() === "", redeems }).toEqual({
      headings: [words.missingTitle], frame: false, blank: false, redeems: [],
    });
  });
});
