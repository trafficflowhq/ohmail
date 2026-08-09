/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { CloudSuggest } from "../src/CloudSuggest.js";
import { suggestDoorFor } from "../src/doors.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import type { SenderSuggestion } from "../../webapp/app/shell/screener-suggest";

/**
 * BUYING SUGGESTIONS FOR A HOSTED ACCOUNT, FROM THE APP.
 *
 * An install pointed at a hosted account had no way to buy suggestions at all: the control the
 * shared client draws reaches a server through the browser's API client, which is not part of this
 * app, so it reported "there is no server here" and was withheld. Correct on a standalone install,
 * where nothing is metered and a different control fits. A hole on a hosted one, where the account
 * has an allowance, a balance, and a Screener full of first-contact senders — a feature the same
 * account has in a browser tab, missing in the app, for want of a way to ask.
 *
 * ── WHAT THESE ASSERTIONS ARE ABOUT, AND WHY THEY ARE ON THE WIRE ───────────────────────────
 *
 * The fix is deliberately NOT a second purchase flow. It is the shared one, given a transport that
 * addresses the account through the mail engine on this machine. So what is worth proving is that
 * the money rules survived the substitution, and every one of them is visible only in the requests
 * that leave:
 *
 *  · nothing is charged before a price has been shown — the first request of any press is a dry run
 *    and it carries no idempotency key, because a dry run has nothing to replay;
 *  · a purchase is split into request-sized chunks and EVERY CHUNK CARRIES ITS OWN KEY. One key
 *    across chunks would make the second chunk replay the first one's answer; no key at all would
 *    make a lost answer into a second charge. Both are silent, and both are money.
 *  · what is bought is the exact set that was priced, in the queue's own order.
 *
 * The door decision is here too, because "which control does this install get" is the question that
 * was answered wrongly for the whole life of the hosted door.
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

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const host = globalThis as unknown as Host;

/** One answer, framed exactly as the shell frames one for the bridge. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked {
  method: string;
  url: string;
  body: unknown;
  key: string | null;
}

/**
 * A stand-in engine that records every request and answers the two routes the transport uses.
 *
 * The suggest answer is composed from the request, so a chunk of eight is answered for eight
 * senders and a dry run quotes what it was asked about — which is what makes "the set that was
 * priced is the set that was bought" checkable rather than assumed.
 */
function engineAnswering(): { asked: Asked[] } {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const p = (payload ?? {}) as {
        method?: string; url?: string; body?: number[]; headers?: Array<[string, string]>;
      };
      const raw = p.body && p.body.length > 0
        ? new TextDecoder().decode(Uint8Array.from(p.body))
        : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const key = (p.headers ?? []).find(([n]) => n.toLowerCase() === "idempotency-key")?.[1] ?? null;
      asked.push({ method: p.method ?? "GET", url: p.url ?? "", body, key });

      if ((p.url ?? "").startsWith("/screener?")) {
        return encode(200, JSON.stringify({
          items: [], nextCursor: null,
          suggestable: { senders: [], credits: 0, maxPerRequest: 25 },
        }));
      }
      const senders = ((body?.senders as string[] | undefined) ?? []);
      const dryRun = body?.dryRun === true;
      return encode(200, JSON.stringify({
        dryRun,
        requested: senders.length,
        quoted: senders.length,
        quotedCredits: senders.length * 2,
        charged: dryRun ? 0 : senders.length * 2,
        remainingCredits: dryRun ? undefined : 500,
        suggestions: dryRun ? [] : senders.map((s, i) => ({
          sender: s, messageId: `m-${i}`, decision: "yes",
          destination: "INBOX", confidence: 0.9, rationale: "known correspondent",
        })),
        skipped: [],
      }));
    },
  };
  return { asked };
}

const SENDERS = Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, "0")}@example.com`);

describe("the hosted door's suggest control", () => {
  let hostEl: HTMLDivElement;
  let root: Root;
  let absorbed: Array<{ address: string; suggestion: SenderSuggestion }>;

  const mount = async (senders = SENDERS, resuggestable: string[] = []) => {
    absorbed = [];
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
    await act(async () => {
      root.render(
        h(
          NextIntlClientProvider,
          { locale: "en", messages: messages as never, timeZone: "UTC" },
          h(
            ThemeProvider,
            null,
            h(
              ToastHost,
              null,
              h(CloudSuggest, {
                senders,
                resuggestable,
                absorb: (rows) => { absorbed.push(...rows); },
              }),
            ),
          ),
        ),
      );
    });
  };

  const buttons = () => [...hostEl.querySelectorAll("button")];

  const click = async (label: string) => {
    const button = buttons().find((b) => b.textContent?.trim() === label);
    if (!button) {
      throw new Error(
        `no button labelled "${label}" — found: ${buttons().map((b) => b.textContent).join(" | ")}`,
      );
    }
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  /** The confirm, whatever number the server quoted into its label. */
  const confirm = async () => {
    const button = buttons().find((b) => /^Suggest for \d+ sender/.test(b.textContent ?? ""));
    if (!button) {
      throw new Error(`no confirm — found: ${buttons().map((b) => b.textContent).join(" | ")}`);
    }
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  afterEach(async () => {
    await act(() => root.unmount());
    hostEl.remove();
    delete host.__TAURI_INTERNALS__;
  });

  it("shows the ladder on a queue that has senders waiting", async () => {
    engineAnswering();
    await mount();
    expect(buttons().map((b) => b.textContent)).toContain("Suggest…");
  });

  /**
   * NOTHING IS ASKED FOR WITHOUT A PRESS — and the read that DOES happen spends nothing.
   *
   * The one request a mounted control is allowed to make is the page of answers already on record,
   * which is how a chip survives a relaunch. If any purchase left before a button was touched, this
   * is where it would show.
   */
  it("buys nothing until something is pressed", async () => {
    const engine = engineAnswering();
    await mount();
    expect(engine.asked.filter((a) => a.method === "POST")).toEqual([]);
    expect(engine.asked.map((a) => a.method)).toEqual(["GET"]);
  });

  it("prices before it charges, and the dry run carries no key", async () => {
    const engine = engineAnswering();
    await mount();
    await click("Suggest…");

    const posts = engine.asked.filter((a) => a.url === "/screener/suggest");
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect((post.body as { dryRun?: boolean }).dryRun).toBe(true);
      // A dry run moves nothing, so there is nothing for a replay to protect — and a key spent on
      // a request that never charged is a key the real run cannot reuse.
      expect(post.key).toBeNull();
    }
    // The price on screen is the SERVER's — 40 senders at 2 apiece, summed over the chunks that
    // priced them, never a count multiplied here.
    expect(hostEl.textContent).toContain("80");
  });

  /**
   * THE GUARD THIS FILE EXISTS FOR.
   *
   * Drop the key from the transport and this goes red on the first chunk; share one key across the
   * chunks and it goes red on the second. Both are silent in every other test in this repository,
   * and both are money: the first turns a lost answer into a second charge, the second makes chunk
   * two replay chunk one's answer and quietly lose the senders it was supposed to buy.
   */
  it("buys in chunks, each with its own idempotency key", async () => {
    const engine = engineAnswering();
    await mount();
    await click("Suggest…");
    await confirm();

    const bought = engine.asked.filter(
      (a) => a.url === "/screener/suggest" && (a.body as { dryRun?: boolean }).dryRun !== true,
    );
    expect(bought.length).toBeGreaterThan(1);

    const keys = bought.map((a) => a.key);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);

    // THE SET THAT WAS PRICED IS THE SET THAT WAS BOUGHT, in the queue's own order, so the same
    // press twice covers the same senders and a person can predict what they are buying.
    const posted = bought.flatMap((a) => (a.body as { senders: string[] }).senders);
    expect(posted).toEqual(SENDERS);
    // No request is larger than one chunk — the bound that keeps a purchase ticking forward
    // instead of freezing on a request that cannot finish.
    for (const a of bought) expect((a.body as { senders: string[] }).senders.length).toBeLessThanOrEqual(15);
  });

  it("lands what it bought in the overlay the rows read", async () => {
    engineAnswering();
    await mount(SENDERS.slice(0, 3));
    await click("Suggest…");
    await confirm();

    expect(absorbed.map((r) => r.address)).toEqual(SENDERS.slice(0, 3));
    expect(absorbed[0]?.suggestion.dest).toBe("ohbox");
  });

  /**
   * A WORKED QUEUE STILL HAS A CONTROL. Nothing left to buy is not nothing left to say: the resting
   * state states how many senders have an answer and offers the one action that is still true.
   * Without the re-ask half of the queue reaching this control, a hosted install that had used the
   * feature most would find it had disappeared.
   */
  it("rests rather than vanishes once every sender has an answer", async () => {
    engineAnswering();
    await mount([], SENDERS.slice(0, 7));
    expect(hostEl.textContent).toContain("7");
    expect(buttons().map((b) => b.textContent)).toContain("Suggest again…");
  });
});

/**
 * WHICH CONTROL AN INSTALL GETS — the decision on its own, without a window around it.
 */
describe("the suggest control each door gets", () => {
  const serving = (over: Partial<EngineStatus>): EngineStatus => ({
    state: "serving", mailboxId: "mbx-1", credentialState: "ready", ...over,
  });

  it("gives a standalone install its own control", () => {
    expect(suggestDoorFor(serving({ mode: "local" }))).toBe("local");
    // And keeps it whatever the hosted-session field says — there is no hosted session on this door.
    expect(suggestDoorFor(serving({ mode: "local", credentialState: "absent" }))).toBe("local");
  });

  it("gives a signed-in hosted install the shared one", () => {
    expect(suggestDoorFor(serving({ mode: "cloud" }))).toBe("cloud");
  });

  it("offers nothing where a press could only be refused", () => {
    // Signed out of the hosted account: every press would fail on the one thing this window
    // cannot fix from inside the Screener.
    expect(suggestDoorFor(serving({ mode: "cloud", credentialState: "absent" }))).toBeNull();
    expect(suggestDoorFor(serving({ mode: "cloud", credentialState: "unreadable" }))).toBeNull();
    // No door chosen, and no answer from the shell at all.
    expect(suggestDoorFor(serving({ mode: null }))).toBeNull();
    expect(suggestDoorFor(null)).toBeNull();
  });
});
