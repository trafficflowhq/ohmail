/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { AWAY_ANSWERABLE_PILES, AWAY_PILE_VIEW, type AwayPile } from "@trafficflow/core/away-scope";
import { PANE_IDS } from "../app/views/SettingsView";

/**
 * THE AWAY RESPONDER'S OHBOX NOTICE — the tell for the one state in which this product sends
 * mail on its own.
 *
 * The responder shipped with a sender, an audience, a suppression set and a Settings control —
 * and no surface on the pane its owner actually reads, so "mail is being answered for you" was
 * invisible outside Settings → Screener. The notice is one quiet line in the Ohbox header, held
 * by the SHELL (one `GET /away-responder` per tab, never one per Ohbox visit) and rendered
 * through `OhboxView`'s `standingNotice` slot — the list's first block, inside the scroller.
 *
 * ── WHAT MUST BE TRUE ────────────────────────────────────────────────────────────────────
 *
 *  1. RESPONDER ON → THE NOTICE RENDERS, and its sentence matches the stored AUDIENCE. The
 *     copy is a claim about who is answered, and the two audiences answer different people —
 *     one sentence for both would be false for one of them.
 *  2. RESPONDER OFF → NOTHING. No placeholder, no empty strip.
 *  3. NO SERVER TO ASK → NOTHING, AND NO READ IS EVEN ISSUED. The hook's gate is the same one
 *     the settings row lives behind (`autoOptIn.supported`); a standalone install draws
 *     nothing and asks nothing. Mutating the gate makes the no-fetch assertion red, because
 *     the stub is deliberately primed with an ENABLED responder.
 *  4. THE SETTINGS ROW'S SAVE ECHO FLIPS THE NOTICE IN THE SAME TAB — the seam that keeps the
 *     one-read-per-tab design honest for the person most likely to look: the one who just
 *     turned it on.
 *  5. THE AFFORDANCE LANDS ON THE PANE THAT CONTROLS IT — Settings, the responder's OWN pane, via
 *     the `?settings=<pane>` deep link `initialPaneFromUrl` reads at mount.
 *  6. The shell wiring itself is pinned by source, the way `demo-gate.test.ts` pins the
 *     ceremony panes: the gate is a ternary at the OhboxView call site in `AppShell`, and a
 *     probe here cannot notice that ternary being edited away.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
/**
 * BEFORE ANY IMPORT OF `api-client`: `API_BASE` is a module-level `const` read ONCE at load
 * (`api-client.ts`), and `apiConfigured()` — the hook's own gate — is derived from it. A plain
 * statement here is NOT early enough, because ESM evaluates every `import` above the module
 * body: the `PANE_IDS` import above reaches `api-client` transitively, so it captured
 * `API_BASE = null` and `useAwayNotice` then declined to read at all.
 *
 * That is not hypothetical — it is what this file did between (which added the
 * `PANE_IDS` assertion) and the fix. The four cases that require the notice to RENDER went red
 * while the two that assert its ABSENCE stayed green **vacuously**, which is why it read as
 * four defects instead of one broken precondition.
 *
 * `vi.hoisted` is hoisted above the imports, so it fixes the class rather than this instance:
 * a future top-level import that also reaches `api-client` can no longer disarm the fixture.
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE = "/api";
});

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

/**
 * Under jsdom `import.meta.url` is an `http:` URL, so the file-URL trick the node-env source
 * tests use is unavailable. The suite runs from the repo root (and `pnpm -F` runs from the
 * package), so resolve against whichever of the two cwd shapes exists.
 */
const APP = existsSync("apps/webapp/app") ? "apps/webapp/app" : "app";
const read = (p: string): string => readFileSync(`${APP}/${p}`, "utf8");

const NOW = new Date("2026-08-02T12:00:00.000Z");

/** What the server currently stores for the account's away responder. */
let stored: {
  enabled: boolean;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  audience: "screened_in" | "everyone";
  throttle: "always" | "per_message" | "per_day" | "per_week";
  /** Which piles are answered. The default responder answers the Ohbox alone (mail 0096). */
  piles: AwayPile[];
  updatedAt: string | null;
};

interface Recorded { method: string; path: string }
let calls: Recorded[] = [];

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (path === "/away-responder") {
      if (method === "PUT") {
        const next = JSON.parse(String(init?.body)) as Omit<typeof stored, "updatedAt">;
        stored = { ...next, updatedAt: NOW.toISOString() };
      }
      return json(stored);
    }
    return json({ error: { code: "not_found", message: "no such route" } }, 404);
  }) as typeof fetch;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function ohboxProps(): Record<string, unknown> {
  return {
    demo: false, settled: true,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    resurfacedRows: [],
    newForYou: [{
      id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: "subj", from: { name: "s", address: "s@ex.example" }, to: [], cc: [],
      date: "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: "snip",
      unread: true, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
    }],
    previouslySeen: [], replyDone: null,
    tags: [], now: NOW,
    selectedId: null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
    onMarkSeen: () => {},
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
  };
}

/**
 * Mount the REAL view over the REAL hook, wired exactly as `AppShell` wires them: the shell
 * holds the state (`useAwayNotice`), the view gets a node or `undefined`, and the settings
 * row — when this probe includes it — reports through the same `update` echo.
 */
async function mount(opts: { active: boolean; withRow?: boolean }): Promise<void> {
  const OhboxView = await (await import("./ohbox/_today.js")).prepareToday();
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const { AwayNotice, useAwayNotice } = await import("../app/shell/AwayNotice.js");
  const { AwayResponderRow } = await import("../app/shell/AwayResponderRow.js");

  function Probe(): React.ReactElement {
    const awayNotice = useAwayNotice(opts.active);
    return h("div", null,
      h(OhboxView as never, {
    settled: true, owed: false,
        ...ohboxProps(),
        standingNotice: !opts.active || !awayNotice.on
          ? undefined
          : h(AwayNotice, {
            audience: awayNotice.audience,
            throttle: awayNotice.throttle,
            piles: awayNotice.piles,
          }),
      } as never),
      opts.withRow ? h(AwayResponderRow as never, { onChanged: awayNotice.update } as never) : null,
    );
  }

  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(KeymapProvider as never, { children: h(Probe) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
  /*
   * TWO macrotasks, not one, and the second is not belt-and-braces.
   *
   * `AwayResponderRow` loads its own state on mount, and that chain settles a tick after the
   * notice's does — so a single flush left the row's `setState` landing OUTSIDE `act` and React
   * printed "An update to AwayResponderRow inside a test was not wrapped in act(...)" on all 11
   * cases. It only began appearing when the `vi.hoisted` fix armed the fixture and the row
   * actually started reading, so the warnings were a symptom of the file WORKING.
   *
   * Flushed rather than silenced, because a suite that prints warnings is one where a real
   * warning is not noticed — the same argument the shell's boot effect makes for writing no
   * state of its own.
   */
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const notice = (): HTMLElement | null => host!.querySelector(".ohx-away");

/**
 * React's controlled inputs ignore a plain `.value=`; go through the native setter.
 *
 * `act`-wrapped and therefore async: the dispatched `input` event drives a `setState` inside
 * `AwayResponderRow`, and doing that outside `act` is what printed "An update to
 * AwayResponderRow inside a test was not wrapped in act(...)". Those warnings only appeared once
 * the `vi.hoisted` fix armed this fixture and the row began to render at all — a symptom of the
 * file WORKING — and they are flushed rather than silenced, because a suite that prints warnings
 * is one where a real warning is not noticed.
 */
async function setNative(el: HTMLInputElement | HTMLTextAreaElement, v: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  calls = [];
  stored = {
    enabled: false, body: null, startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
  };
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
  window.history.replaceState(null, "", "/");
  window.location.hash = "";
});

describe("the away responder's Ohbox notice", () => {
  it("responder ON → one quiet line in the Ohbox, naming the narrow audience", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Away responder is on");
    // The audience is part of the claim: `screened_in` answers only senders already let in.
    expect(el!.textContent).toContain("let in");
    expect(el!.textContent).not.toContain("Everyone");
  });

  it("responder ON for EVERYONE → the sentence widens with the audience", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Away responder is on");
    expect(el!.textContent).toContain("veryone who writes");
  });

  /**
   * THE RATE IS THE SECOND HALF OF THE CLAIM, and it is asserted per member rather than once.
   *
   * The notice is ONE ICU message with two `select`s, so the failure this covers is specific to
   * that shape: an arm whose label is wrong, or missing (which ICU resolves to `other` — the
   * once-a-day sentence) is a line that describes a responder behaving differently from the one
   * that is running. `per_week` reading as "at most once a day" would be the notice quietly
   * understating how often a stranger hears from this address by a factor of seven.
   *
   * Both selects are exercised together in the last case, because their arms are interpolated into
   * one sentence and a template that renders each correctly in isolation can still produce a
   * mangled combination.
   */
  it("each throttle names its own rate in the notice — every arm of the select", async () => {
    const rates: ReadonlyArray<[typeof stored.throttle, string]> = [
      ["always", "every message"],
      ["per_message", "until you change the text"],
      ["per_day", "at most once a day"],
      ["per_week", "at most once a week"],
    ];
    for (const [throttle, sentence] of rates) {
      stored.enabled = true;
      stored.audience = "screened_in";
      stored.throttle = throttle;
      await mount({ active: true });
      const el = notice();
      expect(el, `throttle=${throttle} rendered no notice`).not.toBeNull();
      expect(el!.textContent, `throttle=${throttle}`).toContain(sentence);
      if (root) await act(async () => { root!.unmount(); });
      host?.remove(); root = null; host = null;
    }
  });

  it("the widened audience and the loosest rate compose into one sentence", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    stored.throttle = "always";
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    // One sentence, both variable parts resolved — not a fragment and not a leftover `{throttle}`.
    expect(el!.textContent).toContain("everyone who writes");
    expect(el!.textContent).toContain("every message");
    expect(el!.textContent).not.toContain("{");
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE SCOPE IS THE THIRD HALF OF THE CLAIM (0.16 owner feedback item 4)
     ══════════════════════════════════════════════════════════════════════════════════════════

     What was reported: a banner reading "people you've let in get a reply at most once a day"
     over a responder that had answered eight shop and notification senders. Every word of it was
     true and it still did not describe what was happening, because the sentence named WHO and the
     surprise was WHICH MAIL. So the scope is in the sentence now, and these cases are what stop
     it from being decoration: the wrong scope word is a claim about mail leaving somebody's
     account, and it is the kind that reads perfectly.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("the DEFAULT scope names the Ohbox — the sentence the reported banner was missing", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    stored.throttle = "per_day";
    stored.piles = ["INBOX"];
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    // The whole sentence, assembled — four interpolations and no leftover placeholder.
    expect(el!.textContent).toContain(
      "Away responder is on — people you've let in whose mail lands in Ohbox get a reply at most "
      + "once a day.",
    );
  });

  it("News opted in widens the scope clause, and only the scope clause", async () => {
    stored.enabled = true;
    stored.piles = ["INBOX", "ohmail/News"];
    await mount({ active: true });
    const el = notice();
    expect(el!.textContent).toContain("whose mail lands in Ohbox or in News");
    expect(el!.textContent).toContain("at most once a day");
    expect(el!.textContent).toContain("let in");
  });

  it("News WITHOUT the Ohbox says News, and does not claim the Ohbox is answered", async () => {
    // Reachable through the API rather than the control, and the reason the clause is a LIST of
    // what is answered: a fixed sentence would name a pile that is NOT being answered.
    stored.enabled = true;
    stored.piles = ["ohmail/News"];
    await mount({ active: true });
    const el = notice();
    expect(el!.textContent).toContain("whose mail lands in News");
    expect(el!.textContent).not.toContain("Ohbox");
  });

  /**
   * A RESPONDER ANSWERING NOBODY GETS ITS OWN SENTENCE. Given a `none` arm inside the main
   * sentence, every wording that fits its grammar is false — naming a pile claims replies are
   * going out, and an empty clause claims it more quietly by leaving the scope unsaid.
   */
  it("an EMPTY scope says nothing is sent, and never names a pile", async () => {
    stored.enabled = true;
    stored.piles = [];
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("no pile is set to get a reply");
    expect(el!.textContent).toContain("nothing is sent");
    expect(el!.textContent).not.toContain("Ohbox");
    expect(el!.textContent).not.toContain("at most once a day");
  });

  /**
   * A SERVER ONE RELEASE OLDER answers no `piles` at all. The notice must not invent a scope it
   * was not told — there is no path from "I do not know" to a sentence about which mail is being
   * answered — so an absent field reads as the empty scope and the line says nothing is sent.
   */
  it("a server that does not send `piles` yields no scope claim", async () => {
    stored.enabled = true;
    delete (stored as { piles?: unknown }).piles;
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("nothing is sent");
    expect(el!.textContent).not.toContain("{");
  });

  /**
   * THE TWO PILES ADDED IN 0.16.1 REACH THE SENTENCE, joined in the reader's own language. The
   * clause is a `Intl.ListFormat` DISJUNCTION over what is answered — one message lands in one
   * pile — so a fifth pile needs one word and no new sentence.
   */
  it("Receipts and the Screener are named in the clause, and the list reads as a list", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    stored.piles = ["INBOX", "ohmail/Receipts", "ohmail/Screener"];
    await mount({ active: true });
    /* THE PLATFORM'S OWN LIST, measured rather than guessed: `Intl.ListFormat`'s English
       disjunction of three carries the serial comma. */
    expect(notice()!.textContent)
      .toContain("whose mail lands in Ohbox, in Receipts, or in the Screener");
  });

  /**
   * AND THE SCREENER IS NOT NAMED BESIDE THE NARROW AUDIENCE, even when the row holds it: the
   * audience is asked first in the rule, so no waiting stranger is answered and a sentence naming
   * that pile would state a reply going out where none is. The projection is
   * `awayEffectivePiles`, the same one the settings control reads.
   */
  it("a stored Screener pile beside `screened_in` is not named — it answers nobody", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    stored.piles = ["INBOX", "ohmail/Screener"];
    await mount({ active: true });
    const text = notice()!.textContent ?? "";
    expect(text).toContain("whose mail lands in Ohbox");
    expect(text, "the banner named a pile the responder does not answer")
      .not.toContain("Screener");
  });

  /**
   * THE SENTENCE IS THE BANNER'S OWN TEXT — both arms. The two lanes that met at the merge base
   * each owned half of this element: one the `Banner` primitive it renders through, the other the
   * scope-aware sentence it renders. `notice()` finds the Banner (`.ohx-away` is its class) and
   * `.banner-text` is the primitive's text slot, so a sentence rendered beside the element rather
   * than inside it — a sibling, a second span, the action slot — reads as absent here. Watched red
   * on the merge base by moving the sentence out of the element, and by dropping each arm.
   */
  it("the scope sentence is the Banner's own text (a named scope)", async () => {
    stored.enabled = true;
    stored.piles = ["INBOX", "ohmail/News"];
    await mount({ active: true });
    const text = notice()!.querySelector(".banner-text");
    expect(text, "the Banner has no text slot").not.toBeNull();
    expect(text!.textContent).toContain("whose mail lands in Ohbox or in News");
  });

  it("the scope sentence is the Banner's own text (the empty scope)", async () => {
    stored.enabled = true;
    stored.piles = [];
    await mount({ active: true });
    const text = notice()!.querySelector(".banner-text");
    expect(text, "the Banner has no text slot").not.toBeNull();
    expect(text!.textContent).toContain("nothing is sent");
    expect(text!.textContent).not.toContain("whose mail lands in");
  });

  /**
   * IT IS A STANDING PANE, NOT A PILE SUBLINE.
   *
   * Reported from real use: the notice "looks like a permanent info pane" is what it should look
   * like, and what it looked like instead was one more line of the same 12px `--ink2` prose the
   * Parked and Answer-later pile descriptions are written in — the same shape, directly above
   * them. The difference is not the words, which are unchanged; it is that this one reports a
   * condition holding until its owner ends it, while every other tenant of this slot announces a
   * change and carries its own way to make it go.
   *
   * So the box is asserted, and asserted through the STYLESHEET as well as the class — a class
   * nothing styles is not a pane.
   */
  it("stands in a box of its own, distinct from the pile sublines under it", async () => {
    stored.enabled = true;
    await mount({ active: true });
    const el = notice();
    expect(el, "no notice rendered").not.toBeNull();
    expect(el!.classList.contains("banner"), "the notice is still a bare subline").toBe(true);
    /* The organizer notice is the header slot's OTHER tenant and it is deliberately NOT a pane:
       it is a change announcement with a "Mark read" that ends it. The pane is the `Banner`
       primitive (`packages/ui`), so its rules are read from the primitive's own stylesheet —
       resolved for both cwd shapes this file runs from, as `read` is. */
    const UI = existsSync("packages/ui/src") ? "packages/ui/src" : "../../packages/ui/src";
    const css = readFileSync(`${UI}/primitives/banner.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\n\.banner\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule, "nothing styles the pane class — it is a class that does nothing").not.toBe("");
    // A tinted ground and a leading rule: an object, before it is read as a sentence. The wash is
    // painted over the panel so a PINNED banner stays opaque while rows pass under it.
    expect(rule, "the pane has no ground").toContain("background:linear-gradient(var(--accent-soft),var(--accent-soft)) var(--panel)");
    expect(rule, "the pane has no leading rule").toContain("border-inline-start:2px solid var(--accent)");
    // Both faces out of the tokens: paper rounds it, ohmarchy squares it. No face is named.
    expect(rule).toContain("border-radius:var(--r-card)");
    expect(rule, "a face is named in the rule — the one-UI law").not.toMatch(/ohmarchy|paper|data-face/);
    /* NOT AN ALERT. Nothing here is wrong and the responder being on is usually wanted, so the
       warning tokens have no business in this rule. */
    expect(rule, "the standing fact is dressed as a warning").not.toMatch(/--warn|--danger|--bad|--alert/);
    // …and the sentence may wrap rather than push the box wider — the 420px case.
    const span = /\n\.banner-text\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(span, "the sentence cannot wrap, so a long one widens the pane past its column")
      .toContain("min-width:0");
    // The words are unchanged: the ICU sentence, and its one verb.
    expect(el!.querySelector(".banner-text")!.textContent).toContain("Away responder is on");
    expect(el!.querySelector(".banner-act button")).not.toBeNull();
  });

  /**
   * THE LIST'S FIRST BLOCK, INSIDE THE SCROLLER — the structural half of "pinned wide, in the flow
   * narrow". A jsdom layout cannot scroll, so what is held here is the fact the two forms both
   * depend on: the notice is a DESCENDANT of the list's scroller. Rendered above it (the header
   * slot) it can only ever stay put, at every width; inside it, `banner.css`'s one media rule
   * pins it at 1024px and up and lets it scroll away below. The rendered forms at 390 and 1440 are
   * read in a real browser by `scripts/fit-render.mjs`.
   *
   * Red before the move: the view had no `standingNotice` slot and the line stood in the header.
   */
  it("stands INSIDE the list's scroller, as its first block", async () => {
    stored.enabled = true;
    await mount({ active: true });
    const el = notice();
    expect(el, "no notice rendered").not.toBeNull();
    const scroller = host!.querySelector(".ob-scroll");
    expect(scroller, "no scroller — the list pane did not render").not.toBeNull();
    expect(scroller!.contains(el), "the notice stands ABOVE the scroller — it can never scroll away").toBe(true);
    expect(scroller!.firstElementChild, "the notice is not the scroller's first block").toBe(el);
  });

  it("responder OFF → nothing renders", async () => {
    stored.enabled = false;
    await mount({ active: true });
    expect(notice()).toBeNull();
  });

  it("no server to ask → nothing renders AND no read is issued", async () => {
    // Primed ENABLED on purpose: if the gate is ever mutated away, the fetch fires, the
    // stub answers "on", and both assertions below go red rather than vacuously green.
    stored.enabled = true;
    await mount({ active: false });
    expect(notice()).toBeNull();
    expect(calls.filter((c) => c.path === "/away-responder")).toEqual([]);
  });

  it("A SAVE THAT LANDS FIRST WINS — the in-flight initial read must not undo it", async () => {
    /**
     * Found by the outside review. The one-shot GET and the row's save echo are two writers with
     * no order between them, and `alive` only stops a write after unmount. So: the shell starts
     * its read, the reader opens Away settings and saves, `update()` installs what the server
     * answered — and then the OLDER read resolves and overwrites it. Because the design
     * deliberately never refetches, the notice then states the wrong audience or rate **for the
     * rest of the tab's life**, and what it states is that mail is leaving the account
     * unprompted. This lane's standing pane makes that sentence considerably harder to miss,
     * which is why it is fixed here rather than filed.
     *
     * Driven through the hook's own `transport` seam so the ordering is this test's to choose,
     * rather than the fetch stub's to happen upon.
     */
    let release: ((v: unknown) => void) | null = null;
    const slow = {
      state: () =>
        new Promise((res) => {
          release = () => res({ enabled: true, audience: "everyone", throttle: "always",
            subject: "", body: "", updatedAt: NOW.toISOString() });
        }),
      save: async () => { throw new Error("not used"); },
    };
    const { useAwayNotice } = await import("../app/shell/AwayNotice.js");
    let api: { on: boolean; audience: string; throttle: string;
      update: (n: { enabled: boolean; audience: string; throttle: string }) => void } | null = null;
    function Probe(): null {
      api = (useAwayNotice as never as (a: boolean, t: unknown) => typeof api)(true, slow);
      return null;
    }
    const el = h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(el); });

    // The read is still in flight. The reader saves; this is the server's answer to a WRITE.
    await act(async () => {
      api!.update({ enabled: true, audience: "screened_in", throttle: "per_week" });
    });
    expect(api!.throttle).toBe("per_week");

    // NOW the older read resolves, carrying the state from before the save.
    await act(async () => { release!(null); await new Promise((r) => setTimeout(r, 0)); });
    expect(
      api!.throttle,
      "the in-flight initial read overwrote a newer save — the notice would state the wrong " +
        "rate for the rest of the tab, and there is no refetch to correct it",
    ).toBe("per_week");
    expect(api!.audience, "the audience was overwritten too").toBe("screened_in");
  });

  it("the settings row's save echo flips the notice in the SAME tab, without a refetch", async () => {
    stored.enabled = false;
    await mount({ active: true, withRow: true });
    expect(notice()).toBeNull();

    // Turn it on in the row: switch, message, one explicit Save. There is no subject field to
    // fill — the responder is reply-only and answers under `Re: <what they wrote>`, so the message
    // is the only thing anybody composes.
    const sw = host!.querySelector('[role="switch"]') as HTMLButtonElement;
    await click(sw);
    expect(host!.querySelector("#away-subject"), "the subject field is gone").toBeNull();
    await setNative(host!.querySelector("#away-body") as HTMLTextAreaElement, "Back Monday.");
    const save = Array.from(host!.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    )!;
    await click(save);

    // The notice appeared from the PUT's echo — the shell issued its one GET at mount and,
    // with the row's own mount GET, that is the whole read traffic. No third read.
    expect(notice()).not.toBeNull();
    expect(calls.filter((c) => c.path === "/away-responder" && c.method === "GET").length).toBe(2);
  });

  it("the affordance opens Settings at the AWAY pane, where the control lives", async () => {
    stored.enabled = true;
    await mount({ active: true });
    /* THE ORDER IS THE FACT: the navigation first, the query written after — the app router adopts
       the URL a query write names, and written before the navigation that URL still carried
       `#/ohbox`, which the router restored over the new hash; this link opened nothing on the built
       page (at base too). The spy records the hash at the moment the query is written. Mutation:
       swap the two lines in `openAwaySettings` — red here. */
    const hashAtWrite: string[] = [];
    const real = window.history.replaceState.bind(window.history);
    window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      hashAtWrite.push(window.location.hash);
      return real(data, unused, url ?? undefined);
    }) as typeof window.history.replaceState;
    try {
      const link = notice()!.querySelector("button")!;
      await click(link);
    } finally {
      window.history.replaceState = real;
    }
    expect(window.location.hash).toBe("#/settings");
    expect(hashAtWrite, "the query was written before the navigation").toEqual(["#/settings"]);
    // `away`, not `screener`: the responder has its own section now. Held against `PANE_IDS` as
    // well as against the literal, so a pane name that no longer exists cannot pass here — an
    // unrecognised value is silently `general`, which would land somebody on the wrong screen.
    const asked = new URLSearchParams(window.location.search).get("settings");
    expect(asked).toBe("away");
    expect(PANE_IDS).toContain(asked);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHICH MAIL GETS A REPLY — the pile control on the Away pane (0.16 owner feedback item 4)
   ══════════════════════════════════════════════════════════════════════════════════════════

   The banner learned to say the scope; this is the control that sets it. What must be true: the
   offered set is the ENGINE's constant and nothing else; the Ohbox cannot be switched off; News
   is one press; the press reaches the stored row through the same Save and comes back through the
   same echo the banner reads; the never-list is stated once, in full, as the gloss beside the label.

   Red before the control existed: every case here looked for `input[name="away-piles"]` or the
   labelled group and found nothing. */
describe("the away responder's pile control — which mail gets a reply", () => {
  const group = (): HTMLElement | null =>
    host!.querySelector('[role="group"][aria-labelledby="away-piles-label"]');
  const boxes = (): HTMLInputElement[] =>
    Array.from(host!.querySelectorAll('input[name="away-piles"]')) as HTMLInputElement[];
  const saveButton = (): HTMLButtonElement =>
    Array.from(host!.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "Save") as HTMLButtonElement;
  /** The pile WORD each view key resolves to — the catalogue's, not a literal typed here. */
  const WORD: Record<(typeof AWAY_PILE_VIEW)[AwayPile], string> = {
    ohbox: messages.away.pileOhbox, reads: messages.away.pileReads,
    receipts: messages.away.pileReceipts, screener: messages.away.pileScreener,
  };

  /**
   * THE EXPECTED LIST IS DERIVED FROM THE CONSTANT, so a folder added to the engine's set passes
   * here without an edit — which is the point. The discriminating mutation is the other way round:
   * a control that lists its piles by hand goes red the moment the constant changes, and this is
   * the case that reddens.
   */
  it("offers exactly the engine's answerable piles, in the engine's order, each under its pile word", async () => {
    stored.enabled = true;
    await mount({ active: true, withRow: true });
    expect(group(), "no labelled pile group on the pane").not.toBeNull();
    expect(boxes().map((b) => b.value)).toEqual([...AWAY_ANSWERABLE_PILES]);
    expect(boxes().map((b) => b.closest("label")!.querySelector("b")!.textContent))
      .toEqual(AWAY_ANSWERABLE_PILES.map((p) => WORD[AWAY_PILE_VIEW[p]]));
    expect(document.getElementById("away-piles-label")!.textContent).toBe(messages.away.pilesLabel);
    // The note is the group's DESCRIPTION — the pane's own microcopy line, reached through the group.
    const noteId = group()!.getAttribute("aria-describedby")!;
    expect(document.getElementById(noteId)!.textContent).toBe(messages.away.pilesNote);
    expect(document.getElementById(noteId)!.className).toBe("set-note-inline");
  });

  it("under the default scope the Ohbox is checked and cannot be switched off; News is opt-in", async () => {
    stored.enabled = true;
    stored.piles = ["INBOX"];
    await mount({ active: true, withRow: true });
    const [ohbox, reads] = boxes();
    expect(ohbox.checked, "the Ohbox is not ticked").toBe(true);
    expect(ohbox.disabled, "the Ohbox can be switched off").toBe(true);
    expect(ohbox.closest("label")!.textContent).toContain(messages.away.pileOhboxNote);
    expect(reads.checked).toBe(false);
    expect(reads.disabled).toBe(false);
  });

  /**
   * ONE SOURCE, TWO SURFACES. The tick edits the DRAFT; Save writes the whole row (PUT is a full
   * replace); the banner re-renders from the server's ECHO through `useAwayNotice().update` —
   * never from what was clicked. So the sentence changing here proves the round trip, not a
   * local state.
   */
  it("ticking Reads reaches the draft, Save writes it, and the banner names both piles from the echo", async () => {
    stored.enabled = true;
    stored.body = "Back Monday.";
    stored.piles = ["INBOX"];
    await mount({ active: true, withRow: true });
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox get");
    const reads = boxes()[1];
    await click(reads);
    expect(reads.checked, "the press did not tick Reads").toBe(true);
    expect(stored.piles, "nothing is written before Save").toEqual(["INBOX"]);
    await click(saveButton());
    expect(stored.piles, "the PUT did not carry the widened scope").toEqual(["INBOX", "ohmail/News"]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox or in News");
    // and back: unticking narrows it again, through the same door
    await click(boxes()[1]);
    await click(saveButton());
    expect(stored.piles).toEqual(["INBOX"]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox get");
  });

  /**
   * ══ THE FOUR ROWS, AND THE ONE THAT FOLLOWS THE AUDIENCE (mail 0101) ══════════════════════
   *
   * Receipts is selectable outright. The Screener is selectable only under "Everyone who writes",
   * because a `screened_in` responder never answers a waiting stranger — so with the narrow
   * audience its box is unticked, unpressable, and says why. Unticked rather than "whatever the
   * row holds": a tick there would state a reply going out where none is.
   */
  it("draws four rows in the engine's order, each under its pile word", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    await mount({ active: true, withRow: true });
    expect(boxes().map((b) => b.value))
      .toEqual(["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screener"]);
    expect(boxes().map((b) => b.closest("label")!.querySelector("b")!.textContent))
      .toEqual([messages.away.pileOhbox, messages.away.pileReads,
        messages.away.pileReceipts, messages.away.pileScreener]);
  });

  it("the Screener row is pressable under `everyone`, and its press reaches the PUT", async () => {
    stored.enabled = true;
    stored.body = "Back Monday.";
    stored.audience = "everyone";
    stored.piles = ["INBOX"];
    await mount({ active: true, withRow: true });
    const screener = boxes()[3];
    expect(screener.disabled, "the Screener box is locked under the wider audience").toBe(false);
    expect(screener.closest("label")!.textContent)
      .not.toContain(messages.away.pileScreenerNote);
    await click(screener);
    await click(saveButton());
    expect(stored.piles).toEqual(["INBOX", "ohmail/Screener"]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox or in the Screener");
  });

  it("…and is locked with its reason under `screened_in`, whatever the row holds", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    stored.piles = ["INBOX", "ohmail/Screener"];
    await mount({ active: true, withRow: true });
    const screener = boxes()[3];
    expect(screener.disabled, "the Screener box is pressable under the narrow audience").toBe(true);
    expect(screener.checked, "a locked box drawn ticked claims a reply that is not sent")
      .toBe(false);
    expect(screener.closest("label")!.textContent).toContain(messages.away.pileScreenerNote);
  });

  /**
   * NARROWING THE AUDIENCE DROPS THE PILE, in the draft and therefore in the PUT — the pair is
   * refused at the write door, so a save carrying both would 400 and the person would read "that
   * did not save" about a field they never touched.
   */
  it("switching to `screened_in` drops the Screener from the draft and from the save", async () => {
    stored.enabled = true;
    stored.body = "Back Monday.";
    stored.audience = "everyone";
    stored.piles = ["INBOX", "ohmail/Screener"];
    await mount({ active: true, withRow: true });
    expect(boxes()[3].checked).toBe(true);
    const narrow = Array.from(host!.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === messages.away.screenedIn,
    )!;
    await click(narrow);
    expect(boxes()[3].checked, "the box stayed ticked under an audience that answers nobody there")
      .toBe(false);
    await click(saveButton());
    expect(stored.piles).toEqual(["INBOX"]);
    expect(stored.audience).toBe("screened_in");
  });

  it("Receipts is selectable outright — no audience condition on that row", async () => {
    stored.enabled = true;
    stored.body = "Back Monday.";
    await mount({ active: true, withRow: true });
    const receipts = boxes()[2];
    expect(receipts.disabled).toBe(false);
    await click(receipts);
    await click(saveButton());
    expect(stored.piles).toEqual(["INBOX", "ohmail/Receipts"]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox or in Receipts");
  });

  /**
   * THE OHBOX IS NOT FORCED ON. The column admits a scope without it (reachable through the API),
   * and a tick drawn over such a row would state that replies go to mail that gets none — the same
   * false claim the banner's own empty-scope sentence refuses. The control shows the stored truth
   * and leaves the way back to the default one press wide.
   */
  it("a stored scope WITHOUT the Ohbox shows the truth: unticked and pressable, no 'always answered'", async () => {
    stored.enabled = true;
    stored.piles = ["ohmail/News"];
    await mount({ active: true, withRow: true });
    const [ohbox, reads] = boxes();
    expect(ohbox.checked).toBe(false);
    expect(ohbox.disabled, "an unticked Ohbox must be pressable, or the default is unreachable").toBe(false);
    expect(ohbox.closest("label")!.textContent).not.toContain(messages.away.pileOhboxNote);
    expect(reads.checked).toBe(true);
    await click(ohbox);
    expect(ohbox.checked).toBe(true);
    expect(ohbox.disabled, "once ticked, the Ohbox locks again").toBe(true);
    expect(ohbox.closest("label")!.textContent).toContain(messages.away.pileOhboxNote);
  });

  it("the never-list is stated once, in full, as the gloss beside the label — and the group is named by the label alone", async () => {
    stored.enabled = true;
    await mount({ active: true, withRow: true });
    const gloss = group()!.querySelector(".gloss-t") as HTMLButtonElement | null;
    expect(gloss, "no gloss beside the pile label").not.toBeNull();
    expect(gloss!.getAttribute("aria-label")).toBe(messages.away.never);
    expect(gloss!.closest(".gloss")!.classList.contains("gloss-chip"), "the glyph is not sized to the label's line").toBe(true);
    // ONCE: the sentence's text lives in the gloss card and in no other element on the pane.
    const holders = Array.from(host!.querySelectorAll("*")).filter((el) =>
      Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").includes("Never sent to")));
    expect(holders.map((el) => el.className)).toEqual(["gloss-pop"]);
    // The group's name is the label alone: the gloss stands outside the element the group is named by.
    const label = document.getElementById("away-piles-label")!;
    expect(label.textContent).toBe(messages.away.pilesLabel);
    expect(label.querySelector(".gloss")).toBeNull();
  });

  it("reads WHO, then WHICH MAIL, then HOW OFTEN — the banner sentence's order", async () => {
    stored.enabled = true;
    await mount({ active: true, withRow: true });
    const audience = host!.querySelector(`[aria-label="${messages.away.audienceLabel}"]`)!;
    const rate = host!.querySelector(`[aria-label="${messages.away.throttleLabel}"]`)!;
    const piles = group()!;
    expect(audience.compareDocumentPosition(piles) & Node.DOCUMENT_POSITION_FOLLOWING, "the pile group is not after the audience").toBeTruthy();
    expect(piles.compareDocumentPosition(rate) & Node.DOCUMENT_POSITION_FOLLOWING, "the rate is not after the pile group").toBeTruthy();
  });
});

describe("the shell wiring, pinned by source", () => {
  // A probe cannot catch the AppShell ternary being edited away — it wires its own copy of
  // the gate. Read the call site instead, the way `demo-gate.test.ts` reads the ceremony
  // panes' gates.
  const shell = read("shell/AppShell.tsx");

  /**
   * `resolvedDemo`, NOT `demo`, AND THE DIFFERENCE IS ONE RENDER WIDE.
   *
   * Found by review on this gate, after `AppShell` had already recorded the identical defect for
   * the wake registration far above it. `useDemoMode` returns the SERVER snapshot on
   * the hydration render so the markup matches; a prerendered route bakes `searchParams = {}`, so
   * on a `?demo=1` page that snapshot is FALSE while the client answer is true. Gated on `demo`,
   * the hook began `GET /away-responder` on that one commit — and an effect's cleanup cannot
   * retract a request that has already left. The demo's whole promise is that nothing does.
   *
   * Pinned by SOURCE rather than by a probe for the reason this describe block states: a probe
   * wires its own copy of the gate and cannot see the call site being edited. The literal is the
   * point — swapping `resolvedDemo` back to `demo` must fail here.
   */
  it("the shell's ONE away read is gated on the RESOLVED demo answer, not the hydration one", () => {
    expect(shell).toMatch(
      /const awayNotice = useAwayNotice\(!resolvedDemo && awaySupported, awayTransport\);/,
    );
    expect(
      shell,
      "the away read is gated on `demo`, which is false for one render on a prerendered ?demo=1 page",
    ).not.toMatch(/useAwayNotice\(!demo /);
  });

  /**
   * `awaySupported` IS THE ONE GATE, AND IT IS TRUE FOR TWO INSTALLS.
   *
   * It was `autoOptIn.supported` alone — `apiConfigured()` — which is false in EVERY desktop build,
   * both doors, because that bundle aliases the Cloud client to a refusing stub. That withheld the
   * responder from the desktop's HOSTED door, where the account is real and the engine forwards
   * this endpoint to it with the bearer. A host transport is therefore the second way to be
   * supported, and the STANDALONE door supplies neither — which is the product boundary, not an
   * oversight: the sender is a pass in the hosted worker and nothing else may reach it.
   */
  it("support is the hosted client OR a host's own wire — never a bare `apiConfigured()`", () => {
    expect(shell).toMatch(
      /const awaySupported = autoOptIn\.supported \|\| awayTransport !== undefined;/,
    );
  });

  it("the Ohbox notice is gated on demo, support, and the responder actually being on", () => {
    // The header slot composes the offer and the organizer notice; the RESPONDER's line has its
    // own slot — `standingNotice`, the list's first block — and its three-part gate survives
    // verbatim inside it, which is what this pin protects.
    expect(shell).toMatch(/noticeSection=\{/);
    expect(shell).toMatch(/standingNotice=\{/);
    // THE GATE, and only the gate. The props moved onto their own lines when the scope was added,
    // so pinning their layout would make this fail for a reformat — which is a pin that cries
    // wolf, and the next person deletes it. What must survive is the three-part condition and
    // that `null` is the false arm.
    expect(shell).toMatch(
      /const away = demo \|\| !awaySupported \|\| !awayNotice\.on\s*\n?\s*\? null\s*\n?\s*:/,
    );
    // …and that all three parts of the claim reach the line, each from the held state and none
    // re-derived at the call site.
    for (const prop of ["audience", "throttle", "piles"]) {
      expect(shell, `<AwayNotice> is not passed ${prop} from the shell's held state`)
        .toMatch(new RegExp(`${prop}=\\{awayNotice\\.${prop}\\}`));
    }
  });

  /**
   * THE SLOT THAT CARRIES THE LINE IS THE SLOT THAT CARRIES ITS SCOPE. The loop above accepts
   * `piles={awayNotice.piles}` anywhere in the shell; this pin reads the `standingNotice` block
   * alone — from its opening to the `noticeSection` that follows it — so a line moved back into
   * the header slot, or a scope handed to some other tenant, cannot satisfy it.
   */
  it("the standingNotice block itself passes the scope to <AwayNotice>", () => {
    const block = /standingNotice=\{([\s\S]*?)\n\s*noticeSection=\{/.exec(shell)?.[1] ?? "";
    expect(block, "no standingNotice block stands before noticeSection").not.toBe("");
    expect(block).toMatch(/<AwayNotice[\s\S]*?piles=\{awayNotice\.piles\}[\s\S]*?\/>/);
  });

  /**
   * THE RETIRED PANE CLASS NAMES NOTHING. `.ohx-notice.ohx-standing` was the pane's rule set in
   * app.css before the `Banner` primitive took the pane over, and the merge that brought the two
   * lanes together had one side still rendering it. Zero elements and zero rules: a class that is
   * styled but never rendered, or rendered but never styled, is the same half-applied state read
   * from either end.
   */
  it("`ohx-standing` names nothing any more — no element, no rule", () => {
    expect(read("shell/AwayNotice.tsx")).not.toContain("ohx-standing");
    const css = read("app.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css, "a rule still styles the retired pane class").not.toMatch(/\.ohx-standing\s*[{,>:.\s]/);
  });

  /**
   * THE WIRES, EACH ONE NAMED, NOT THE MOUNT AS ONE STRING. Read verbatim this pin broke when the
   * paired-desktop door added a fourth prop, having lost no wire — a pin that cries wolf, and the
   * next person deletes it. Each wire is required by name inside the mount, so a rename or a
   * re-derivation at the call site is still red and a FIFTH door's prop is not; no wildcard stands
   * in for a wire. What must survive is that the row's echo returns to the shell's held state and
   * that all three host facts arrive from the props.
   */
  it("the settings row reports its echo into the same held state, down the same wire", () => {
    expect(shell.match(/<AwayResponderRow\b/g)?.length, "not exactly one away-row mount").toBe(1);
    const mount = /<AwayResponderRow\b([\s\S]*?)\/>/.exec(shell)?.[1] ?? "";
    expect(mount, "no <AwayResponderRow> mount in the shell").not.toBe("");
    for (const wire of [
      "onChanged={awayNotice.update}",
      "transport={awayTransport}",
      "local={awayIsLocal ?? false}",
      // The paired-desktop door's own wire: `AwayResponderRow` prefers it over `local`, and it
      // decides which machine the sentence names. `desktop-away.test.tsx` reads the same mount.
      "host={awayOnHost ?? null}",
    ]) {
      expect(mount, `the away row's mount does not carry \`${wire}\``).toContain(wire);
    }
  });

  it("the responder's pane is the injected node itself — absent ⇒ no pane and no nav entry", () => {
    expect(shell).toMatch(/awaySection=\{demo \|\| !awaySupported \? undefined : \(/);
    const view = read("views/SettingsView.tsx");
    /* The tab list lives in `settings-panes.ts` since that change (one list for the nav and the
       palette); the nav still answers from NODE PRESENCE — this pin follows the flag into the
       shared list's gate. */
    expect(view).toMatch(/away: Boolean\(awaySection\),/);
    const panes = read("views/settings-panes.ts");
    expect(panes).toMatch(/\.\.\.\(w\.away \? \[\["away", t\("away"\)\] as \[PaneId, string\]\] : \[\]\)/);
    expect(view).toMatch(/\{shown === "away" \? <SettingsSection>\{awaySection\}<\/SettingsSection> : null\}/);
    // …and it is NOT still drawn inside the Screener pane. Two live controls over one
    // `PUT /away-responder` each hold their own draft; the second Save overwrites the first.
    const screenerPane = /\{shown === "screener" \? \(([\s\S]*?)\n {10}\) : null\}/.exec(view)![1]!;
    expect(screenerPane).not.toContain("awaySection");
  });
});
