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
import { BearerManager } from "../../paired-page/src/bearer.js";
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
