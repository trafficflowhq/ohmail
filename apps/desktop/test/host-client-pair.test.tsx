/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../webapp/messages/en.json";
import { BearerManager, REFRESH_STORAGE_KEY } from "../src/host-client/bearer.js";
import { PairScreen } from "../src/host-client/PairScreen.js";

/**
 * ═══ THE /pair FRAGMENT LANDING — the credential discipline, held behaviourally ═══════════════
 *
 * The QR sends a phone to `/pair#<raw-device-pair-token>`. Four claims carry the screen, and
 * every one is the flow-3 idiom re-proven on this page rather than assumed from the pattern:
 *
 *  · the token is read from the FRAGMENT and scrubbed from the address bar the moment it is held;
 *  · the ONLY request that ever carries it is the redeem's JSON body — no fetch URL contains it;
 *  · a `?token=` QUERY is refused outright (the scan-again screen), so the safe shape cannot
 *    regress by convenience;
 *  · the redeem declares `kind: "web"` — a browser saying what it is — and a success hands the
 *    pair to the manager and calls `onPaired`; the spent-token refusal gets this screen's own
 *    sentence (the remedy is one click on the computer in front of the person).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

interface Sent { url: string; body: Record<string, unknown> | null }
let sent: Sent[];
let answer: () => Response;

beforeEach(() => {
  sent = [];
  answer = () => new Response(JSON.stringify({ tokens: { accessToken: "a1", refreshToken: "r1" } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return answer();
  }) as typeof fetch;
  window.localStorage.clear();
});

let hostEl: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => root.unmount());
  hostEl.remove();
  window.history.replaceState(null, "", "/");
});

async function mount(props: { revoked?: boolean; onPaired?: () => void; strict?: boolean } = {}): Promise<BearerManager> {
  const bearer = new BearerManager({ storage: window.localStorage });
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  const screen = h(NextIntlClientProvider, { locale: "en", messages: messages as never },
    h(PairScreen, { bearer, revoked: props.revoked ?? false, onPaired: props.onPaired ?? (() => undefined) }));
  await act(async () => {
    root.render(props.strict ? h(React.StrictMode, null, screen) : screen);
  });
  // Let the mount effect's redeem settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return bearer;
}

const TOKEN = "dpt_9f3aa77e51c04c7bb2f1d0e6a8b4c2d1";

describe("the fragment discipline", () => {
  it("reads #token once, scrubs the bar, redeems kind web in the BODY, adopts and reports paired", async () => {
    window.history.replaceState(null, "", `/pair#${TOKEN}`);
    let pairedCalls = 0;
    const bearer = await mount({ onPaired: () => pairedCalls++ });

    // Scrubbed: the credential is out of the visible URL and out of an abandoned tab's bar.
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);

    // One request, to the redeem, with the token in the JSON body and NOWHERE in a URL.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("/pair/redeem");
    expect(sent[0]!.body).toEqual({ grant: "device-pair", token: TOKEN, kind: "web" });
    for (const s of sent) expect(s.url).not.toContain(TOKEN);

    expect(bearer.paired()).toBe(true);
    expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBe("r1");
    expect(pairedCalls).toBe(1);
  });

  it("no fragment is the scan-the-QR landing, and nothing is redeemed", async () => {
    window.history.replaceState(null, "", "/pair");
    const bearer = await mount();
    expect(sent).toHaveLength(0);
    expect(bearer.paired()).toBe(false);
    expect(hostEl.textContent).toContain("Scan the code on your computer");
  });

  it("a token moved into the QUERY is refused — the query is never read, never redeemed", async () => {
    window.history.replaceState(null, "", `/pair?token=${TOKEN}`);
    await mount();
    expect(sent).toHaveLength(0);
    expect(hostEl.textContent).toContain("Scan the code on your computer");
  });

  it("STRICT MODE's effect replay redeems ONCE — the token is single-use and the entry mounts under StrictMode", async () => {
    // The review finding: the replayed mount effect started a SECOND redeem with the same
    // single-use token — the first request consumed it and had its answer discarded as
    // "cancelled", the second answered pairing_invalid, and a valid scan failed. The redeem
    // promise has to survive the replay the way the fragment ref does.
    window.history.replaceState(null, "", `/pair#${TOKEN}`);
    let pairedCalls = 0;
    const bearer = await mount({ strict: true, onPaired: () => pairedCalls++ });
    expect(sent).toHaveLength(1);
    expect(bearer.paired()).toBe(true);
    expect(pairedCalls).toBe(1);
  });

  it("a dead session lands here with the pairing-ended sentence", async () => {
    window.history.replaceState(null, "", "/pair");
    await mount({ revoked: true });
    expect(hostEl.textContent).toContain("pairing has ended");
  });
});

describe("refusals", () => {
  it("a spent or expired token gets THIS screen's sentence; onPaired never fires", async () => {
    window.history.replaceState(null, "", `/pair#${TOKEN}`);
    answer = () => new Response(
      JSON.stringify({ error: { code: "pairing_invalid", message: "unknown, expired, spent or revoked" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    let pairedCalls = 0;
    const bearer = await mount({ onPaired: () => pairedCalls++ });
    expect(pairedCalls).toBe(0);
    expect(bearer.paired()).toBe(false);
    expect(hostEl.textContent).toContain("Pairing codes work once and expire");
  });

  it("every other refusal shows the server's own sentence verbatim", async () => {
    window.history.replaceState(null, "", `/pair#${TOKEN}`);
    answer = () => new Response(
      JSON.stringify({ error: { code: "host_busy", message: "too many concurrent requests on this door; retry shortly" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    await mount();
    expect(hostEl.textContent).toContain("too many concurrent requests on this door");
  });
});
