/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  readsPartition,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MessageBodyWire,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
/* The bound the reader surfaces put on "still coming", imported rather than restated: a number
   written here would stop matching the surface the first time the engine's deadline moved. */
import { BODY_STALL_MS } from "../app/shell/message-chrome.js";
import { settleFirstPaint } from "./_first-paint.js";
import { withBodyDoor } from "./_body-door.js";

/**
 * SLICE WHAT THE PILES ACTUALLY SHOW.
 *
 * The report was "on reads / screener / receipts etc. messages do not show a collapse
 * or ellipsis function .. must be able to be opened similar to the normal ohbox." Every one of
 * those piles already HAD the interaction. What they did not have was a body: the wire
 * `MessageDTO` carries `snippet` and never `body`, so on a live account every `StreamCard`
 * measured "short", `.scast.short .sc-x{display:none}` hid its Expand pill, and the Screener's
 * "every held message, in full" was one line per message.
 *
 * So the assertions here are about the two halves of that:
 *
 *  1. a card whose body has not arrived must keep its affordance and must WORK when used —
 *     `toggle()` used to `return` on `short`, which would have made a re-enabled pill inert;
 *  2. the three states that are not the whole message must be distinguishable on screen.
 *
 * ── WHY THE HEIGHTS ARE STUBBED ─────────────────────────────────────────────────────────
 *
 * jsdom lays nothing out: `offsetHeight` is 0 for every element, so `StreamCard`'s measuring
 * effect bails at its own visibility guard and `short` would be permanently false — which is
 * precisely the state in which none of this can be observed. The stubs below give the card a
 * height proportional to its text, which is the only property the clamp decision depends on.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-03T12:00:00.000Z");
/** `StreamCard`'s SC_CLAMP plus its 28 px "no point clamping a few lines" tolerance. */
const CLAMP_PX = 348 + 28;

/** Text long enough that the stubbed height exceeds the clamp — a real newsletter. */
const LONG = "Sanded the north elevation again today. ".repeat(40);

function layoutStubs(): () => void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const offset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  // Non-zero, so the measuring effect runs at all.
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 100 });
  // Two pixels per character: a snippet is a few dozen px, a newsletter is thousands.
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return Math.max(20, (this.textContent?.length ?? 0) * 2); },
  });
  // `scrollTo`/`scrollIntoView` are not implemented in jsdom and both views call them.
  const el = Element.prototype as unknown as Record<string, unknown>;
  const prevScrollTo = el.scrollTo;
  const prevIntoView = el.scrollIntoView;
  el.scrollTo = () => {};
  el.scrollIntoView = () => {};
  return () => {
    if (offset) Object.defineProperty(proto, "offsetHeight", offset); else delete proto.offsetHeight;
    if (scroll) Object.defineProperty(proto, "scrollHeight", scroll); else delete proto.scrollHeight;
    el.scrollTo = prevScrollTo;
    el.scrollIntoView = prevIntoView;
  };
}

let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: `Sender ${over.id}`, address: `${over.id}@example.invalid` },
    to: [],
    cc: [],
    date: "2026-08-03T09:00:00.000Z",
    folder: "ohmail/News",
    snippet: `one line of ${over.id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** Every mutation the surface dispatched — the Screener's side-effect-free claim is measured. */
let sent: EngineMutation[] = [];
/** Every body the engine asked the wire for. */
let bodiesFetched: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let restoreLayout: (() => void) | null = null;

async function engineWith(
  seedMessages: EngineMessage[],
  // the wire carries `html` now, and the DEFAULT here is `null` on purpose: these
  // cases are about the text path, and a body stub that quietly grew an html part would
  // change which renderer every one of them exercises.
  body: (id: string) => Promise<MessageBodyWire> = async (id) => ({
    text: `FULL BODY of ${id}\n${LONG}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  }),
): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    seedMessages.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async (): Promise<SyncResponse> => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m): Promise<MutationOutcome> => {
        sent.push(m);
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (id) => {
        bodiesFetched.push(id);
        return body(id);
      },
    },
  });
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function render(node: React.ReactNode): Promise<void> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: node }));
  });
  // Let the mount effects' hydration land and re-render with the body.
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).CSS ??= { escape: (v: string) => v };
  sent = [];
  bodiesFetched = [];
  restoreLayout = layoutStubs();
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
});

afterEach(async () => {
  await unmount();
  restoreLayout?.();
  restoreLayout = null;
  vi.restoreAllMocks();
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CARD · a snippet must not pass for a whole message, and must stay openable
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const cards = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".scast")];
const pill = (card: HTMLElement): HTMLButtonElement => card.querySelector<HTMLButtonElement>(".sc-x")!;

async function mountCard(props: Record<string, unknown>): Promise<HTMLElement> {
  const { StreamCard } = await import("@ohmail/ui");
  await render(h(StreamCard as never, {
    id: "c1", from: "Sender", time: "09:12", subject: "A subject", ...props,
  } as never));
  return cards()[0]!;
}

describe("StreamCard — the clamp tells the truth about what it is clamping", () => {
  it("a LONG full body clamps and offers the pill: the shape the prototype drew", async () => {
    const card = await mountCard({ body: LONG, bodyState: "full" });
    expect(card.classList.contains("short")).toBe(false);
    expect(card.classList.contains("pend")).toBe(false);
    expect(card.querySelector(".sc-state")).toBeNull();
    // And the pill works.
    await act(async () => { pill(card).click(); });
    expect(pill(cards()[0]!).getAttribute("aria-expanded")).toBe("true");
  });

  it("a SHORT full body is short, draws no pill, says nothing — and still opens for the keyboard", async () => {
    // The one case where no DRAWN pill is the correct answer, and the reason `short` still exists.
    // Its pill stays for the keyboard (drawn on focus, pressed by the stream's Enter) and opens the
    // card: a short mail's verbs and files mount only on the open card (hand back H1).
    const card = await mountCard({ body: "Thanks — see you Friday.", bodyState: "full" });
    expect(card.classList.contains("short")).toBe(true);
    expect(card.classList.contains("pend")).toBe(false);
    expect(card.querySelector(".sc-state")).toBeNull();
    await act(async () => { pill(card).click(); });
    expect(pill(cards()[0]!).getAttribute("aria-expanded")).toBe("true");
  });

  it("A SNIPPET IS SHORT AND STILL OPENABLE — the defect, closed", async () => {
    /**
     * THE HEART OF THAT CHANGE. A one-line snippet measures short; `.scast.short .sc-x{display:none}`
     * then hides the Expand pill; and on a live account that was EVERY card in Reads and
     * Receipts. "No pill, because there is nothing to expand" — the report, from the
     * opposite cause to a missing affordance.
     *
     * `pend` is what re-enables the pill in CSS, and `toggle()`'s `short && !pending` is what
     * makes the re-enabled pill do something. Both are asserted, because either one alone
     * ships a button that is visible and dead, or a body that can never be asked for.
     *
     * Red two ways: drop `pend` from the class list (the CSS rule below has nothing to match,
     * so the pill stays hidden on a real page); or restore `toggle()`'s bare `if (short)
     * return` (the pill renders, and clicking it does nothing — aria-expanded stays false).
     */
    const hydrated: string[] = [];
    const card = await mountCard({
      body: "one line of m1",
      bodyState: "snippet",
      onToggle: (open: boolean) => { if (open) hydrated.push("c1"); },
    });

    expect(card.classList.contains("short")).toBe(true);
    expect(card.classList.contains("pend")).toBe(true);

    await act(async () => { pill(card).click(); });
    expect(pill(cards()[0]!).getAttribute("aria-expanded")).toBe("true");
    // Expanding IS the request for the body.
    expect(hydrated).toEqual(["c1"]);
  });

  it("and the CSS that un-hides that pill exists — and the fade is NOT dropped any more", async () => {
    /**
     * The class is inert without the rule, and the rule lives in a stylesheet jsdom does not
     * load — so it is asserted as text.
     *
     * THE SECOND HALF OF THIS PAIR IS GONE, AND ITS REASON WITH IT. It used to assert
     * `.scast.short.pend .sc-fade{display:none}`, because an 88px gradient over two lines of
     * snippet reads as a rendering fault. `.scast.short .sc-fade{display:none}` already reaches a
     * short waiting card, and a second rule changed the pill's margins at the moment the body
     * arrived (`566 → 550` at 1440). The absence is asserted, not merely un-asserted: this is the
     * one place that named it.
     */
    // `process.cwd()` rather than `import.meta.url`: this file runs under jsdom, where
    // `import.meta.url` is not a file: URL and `fileURLToPath` refuses it. Vitest runs from
    // the repository root (see the root `vitest.config.ts` include globs).
    const css = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/stream.css"), "utf8");
    expect(css).toContain(".scast.short.pend .sc-x{display:flex}");
    expect(css).not.toContain(".scast.short.pend .sc-fade{display:none}");
    // …and the box a waiting card reserves: its own estimate, at most the clamp.
    expect(css).toContain(".scast.pend .sc-clip{min-height:var(--sc-reserve,120px)}");
    // The rule it has to override is still there — otherwise this pair would be decoration.
    expect(css).toContain(".scast.short:not(.open):not(.pend) .sc-x{position:absolute;");
  });

  it("LOADING and FAILED are said, and said differently", async () => {
    const loading = await mountCard({ body: "one line", bodyState: "loading", loadingLabel: "Loading the full message…", failedLabel: "Couldn't." });
    expect(loading.querySelector(".sc-state")!.textContent).toContain("Loading the full message");
    expect(loading.querySelector(".sc-state")!.classList.contains("warn")).toBe(false);

    const failed = await mountCard({ body: "one line", bodyState: "failed", loadingLabel: "Loading…", failedLabel: "Couldn't load the full message" });
    expect(failed.querySelector(".sc-state")!.textContent).toContain("Couldn't load the full message");
    expect(failed.querySelector(".sc-state")!.classList.contains("warn")).toBe(true);
  });

  it("the state line is a SIBLING of the body, never inside it", async () => {
    // `.sc-body` holds the mail. A reader who selects the text of a message must not get the
    // product's own sentence with it.
    const card = await mountCard({ body: "one line", bodyState: "loading", loadingLabel: "Loading the full message…" });
    for (const p of card.querySelectorAll(".sc-body")) {
      expect(p.textContent).not.toContain("Loading the full message");
    }
  });

  it("an OPEN card re-pins to its new height when the body arrives", async () => {
    /**
     * The expand-then-fill order this slice creates. `toggle()` pins `max-height` to the
     * content height measured AT THE CLICK — which, before hydration, is a two-line snippet.
     * Without the re-pin the fetched body is clipped at the snippet's height: the pill works,
     * the request succeeds, and the mail is still one line.
     *
     * Red by removing `open` from the measuring effect's dependency list, or the
     * `if (open) clip.style.maxHeight` line inside it.
     */
    const { StreamCard } = await import("@ohmail/ui");
    const base = { id: "c1", from: "S", time: "09:12", subject: "S" };
    await render(h(StreamCard as never, { ...base, body: "one line", bodyState: "snippet" } as never));
    await act(async () => { pill(cards()[0]!).click(); });

    const pinnedForSnippet = Number.parseInt(
      (cards()[0]!.querySelector<HTMLElement>(".sc-clip")!.style.maxHeight || "0").replace("px", ""), 10);
    expect(pinnedForSnippet).toBeGreaterThan(0);
    expect(pinnedForSnippet).toBeLessThan(CLAMP_PX);

    // The body lands, exactly as a hydration re-render delivers it.
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(StreamCard as never, { ...base, body: LONG, bodyState: "full" } as never),
      }));
    });
    const pinnedForBody = Number.parseInt(
      (cards()[0]!.querySelector<HTMLElement>(".sc-clip")!.style.maxHeight || "0").replace("px", ""), 10);
    expect(pinnedForBody).toBeGreaterThan(CLAMP_PX);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   READS · the pile, over the real engine
   ══════════════════════════════════════════════════════════════════════════════════════════ */

async function mountReads(engine: OhmailEngine): Promise<void> {
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");

  function Host(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const [cur, setCur] = React.useState<string | null>(null);
    return h(KeymapProvider as never, {
      children: h(ReadsView as never, {
    settled: true, owed: false,
        partition: readsPartition(engine.read()),
        tags: [], now: NOW, cur, onCur: setCur,
        aiChip: null, chipState: null, onChipState: () => {},
        markSeen: () => {},
        isSeen: (m: EngineMessage) => !m.unread,
        bodyOf: (m: EngineMessage) => bodyOf(engine.read(), m),
        hydrateBody: (id: string) => { void engine.hydrateBody(id); },
        hydrateBodies: (ids: string[], o?: { urgent?: boolean }) => { void engine.hydrateBodies(ids, o); },
        jumpTo: null, onJumped: () => {},
        // `v` is unused by the view and read here only so the closure is not optimised away —
        // the subscription is what republishes the hydrated body.
        key: v,
      } as never),
    } as never) as React.ReactElement;
  }

  await render(h(Host));
}

describe("Reads — collapsed by default, and openable because the body arrives", () => {
  it("the CURRENT card hydrates, and it is the ONLY one that does", async () => {
    /**
     * The "An unverified account must not be able to generate meaningful cost" invariant's posture, at the surface. `read` is a permissive cost class, so a pile-wide
     * prefetch is cheap to write and wrong to ship: a real Reads folder holds many
     * newsletters, and fetching all of them because the view mounted bills a read for each
     * of them, for mail nobody opened.
     *
     * Red by hydrating `partition.fresh.concat(partition.seen)` in the mount effect — the
     * assertion below becomes three ids.
     */
    const engine = await engineWith([
      msg({ id: "r1", date: "2026-08-03T09:00:00.000Z" }),
      msg({ id: "r2", date: "2026-08-02T09:00:00.000Z" }),
      msg({ id: "r3", date: "2026-08-01T09:00:00.000Z" }),
    ]);
    await engine.start();
    await mountReads(engine);

    // `current` falls back to the first unread, which is the newest — one id, not the pile.
    expect(bodiesFetched).toEqual(["r1"]);
  });

  it("the hydrated card shows the FULL body; its siblings show a snippet AND their pill", async () => {
    /**
     * The report, answered. Before this change every card here rendered
     * `m.body ?? m.snippet` — one line — measured short, and lost its pill; the pile looked
     * like mail with nothing in it and no way to ask for more.
     *
     * Red by reverting `ReadsView`'s card to `body={m.body ?? m.snippet}` with no `bodyState`:
     * the hydrated card falls back to its snippet AND every card claims `full`, so the two
     * assertions fail for the two separate reasons the slice exists to fix.
     */
    const engine = await engineWith([
      msg({ id: "r1", date: "2026-08-03T09:00:00.000Z" }),
      msg({ id: "r2", date: "2026-08-02T09:00:00.000Z" }),
    ]);
    await engine.start();
    await mountReads(engine);

    const byId = new Map(cards().map((c) => [c.dataset.sid, c]));
    const hydrated = byId.get("r1")!;
    expect(hydrated.textContent).toContain("FULL BODY of r1");
    expect(hydrated.classList.contains("pend")).toBe(false);
    expect(hydrated.classList.contains("short")).toBe(false);

    const untouched = byId.get("r2")!;
    expect(untouched.textContent).toContain("one line of r2");
    expect(untouched.textContent).not.toContain("FULL BODY");
    // Short, but pending — so the pill is reachable and asking for the body is possible.
    expect(untouched.classList.contains("short")).toBe(true);
    expect(untouched.classList.contains("pend")).toBe(true);
  });

  it("expanding a snippet card fetches its body, and the card then holds the mail", async () => {
    const engine = await engineWith([
      msg({ id: "r1", date: "2026-08-03T09:00:00.000Z" }),
      msg({ id: "r2", date: "2026-08-02T09:00:00.000Z" }),
    ]);
    await engine.start();
    await mountReads(engine);
    expect(bodiesFetched).toEqual(["r1"]);

    const r2 = cards().find((c) => c.dataset.sid === "r2")!;
    await act(async () => { pill(r2).click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

    expect(bodiesFetched).toEqual(["r1", "r2"]);
    expect(cards().find((c) => c.dataset.sid === "r2")!.textContent).toContain("FULL BODY of r2");
  });

  it("a FAILED fetch says so on the card, rather than passing the snippet off as the mail", async () => {
    // Risk 2, at a stream surface. Red by having the engine write a `ready` record on a
    // rejection: the card shows one line of text and no note, which is the shipped behaviour.
    const engine = await engineWith([msg({ id: "r1" })], async () => { throw new Error("HTTP 500"); });
    await engine.start();
    await mountReads(engine);

    const card = cards().find((c) => c.dataset.sid === "r1")!;
    const note = card.querySelector(".sc-state")!;
    expect(note.textContent).toContain("Couldn't load the full message");
    expect(note.classList.contains("warn")).toBe(true);
    // The pill is still there, because re-expanding is the retry.
    expect(card.classList.contains("pend")).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SCREENER · full bodies by default, and reading them changes nothing
   ══════════════════════════════════════════════════════════════════════════════════════════ */

async function mountScreener(engine: OhmailEngine): Promise<void> {
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");

  function Host(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(KeymapProvider as never, {
      children: h(ScreenerView as never, {
    settled: true, owed: false,
        state, segment: "waiting", selection: sel,
        onSelect: (segment: string, id: string | null) => setSel((s) => ({ ...s, [segment]: id })),
        hydrateBody: (id: string) => { void engine.hydrateBody(id); },
        hydrateBodies: (ids: string[], o?: { urgent?: boolean }) => { void engine.hydrateBodies(ids, o); },
        full: false, onFull: () => {},
      } as never),
    } as never) as React.ReactElement;
  }

  await render(withBodyDoor(engine, h(Host)));
  await settleFirstPaint();
}

const heldArticles = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".scn-mails .hmail")];

describe("Screener — every held message, in full, for the sender being decided about", () => {
  const HELD = [
    msg({ id: "s1", from: { name: "Lena", address: "lena@atelier.example" }, folder: "ohmail/Screener" as Folder, date: "2026-08-03T08:12:00.000Z" }),
    msg({ id: "s2", from: { name: "Lena", address: "lena@atelier.example" }, folder: "ohmail/Screener" as Folder, date: "2026-08-03T08:40:00.000Z" }),
    msg({ id: "s3", from: { name: "Win", address: "win@jackpot.example" }, folder: "ohmail/Screener" as Folder, date: "2026-08-02T08:40:00.000Z" }),
  ];

  it("renders held.length articles, each with the HYDRATED body", async () => {
    /**
     * `ScreenerSenderDTO.held` has promised "every held message, in full — there is deliberately
     * no heldCount / lastSubject / lastBody beside it" since it was written, and
     * `ScreenerView`'s own comment says "NO-COLLAPSE: every held message renders". On a live
     * account both were true about the COUNT and false about the CONTENT: every row is derived,
     * so every body was the snippet, and a consent decision was being taken on one line.
     *
     * This is the live shape — derived rows, no `screener_sender` fixture anywhere — with the
     * bodies fetched.
     *
     * Red by reverting `heldOf` to `m.body ?? m.snippet`: the article count still passes and
     * every body reverts to "one line of s1", which is exactly how the claim outlived the code.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    await mountScreener(engine);

    // The selected sender is the newest, Lena, with two held messages.
    const articles = heldArticles();
    expect(articles).toHaveLength(2);
    expect(articles.map((a) => a.querySelector(".hm-body")!.textContent))
      .toEqual([
        expect.stringContaining("FULL BODY of s1"),
        expect.stringContaining("FULL BODY of s2"),
      ]);
    // Bounded by `held.length`: the OTHER sender's message is not fetched.
    expect(bodiesFetched.sort()).toEqual(["s1", "s2"]);
    // Nothing says "loading" or "couldn't" once the bodies are in.
    expect(host!.querySelector(".scn-mails .hm-state")).toBeNull();
  });

  it("READING HELD MAIL IS SIDE-EFFECT-FREE — nothing is marked seen, nothing moves", async () => {
    /**
     * The ruling's one rule for this pile. The ⇧-twins on the decision keys exist precisely
     * because plain filing does NOT mark held mail read, and a preview that marked it read on
     * sight — or that ran the Ohbox's dwell timer, or moved a waterline — would make that
     * distinction meaningless and would silently consume a stranger's first contact.
     *
     * Red by adding a `mark_seen` (or any mutation) to the selection path: `sent` stops being
     * empty. `hydrateBody` is a GET and writes nothing but a client-local record.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    await mountScreener(engine);

    expect(heldArticles()).toHaveLength(2);
    expect(sent).toEqual([]);
    // The mail is still unread and still held, on the record as well as on screen.
    for (const id of ["s1", "s2", "s3"]) {
      const m = engine.read().get<EngineMessage>("message", id)!;
      expect(m.unread, id).toBe(true);
      expect(m.folder, id).toBe("ohmail/Screener");
    }
  });

  it("a FAILED body says so in the preview — the one place a wrong decision is expensive", async () => {
    /**
     * Risk 2 again, and here it is the sharpest: the whole argument for giving this pile full
     * bodies by default is that a consent decision taken on a truncation is the actual risk.
     * A preview that silently showed a snippet after a failed fetch would reinstate exactly
     * that, with the decision bar sitting above it.
     *
     * Red by dropping `bodyState` from `HeldMail`, or by having `heldOf` not carry it.
     */
    const engine = await engineWith(HELD, async () => { throw new Error("HTTP 503"); });
    await engine.start();
    await mountScreener(engine);

    const notes = [...host!.querySelectorAll<HTMLElement>(".scn-mails .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("Couldn't load the full message");
      expect(n.classList.contains("warn")).toBe(true);
    }
    // And the snippet is still on screen — it is the only text there is.
    expect(heldArticles()[0]!.querySelector(".hm-body")!.textContent).toContain("one line of s1");
  });

  /**
   * ═══ A HELD SENSITIVE MESSAGE SHOWS ITS BODY LIKE ANY OTHER ════════════════════════════
   *
   * Body withholding is removed. A verification code from a stranger is the ORDINARY case at the
   * gate — the person deciding about the sender is entitled to read what the sender sent — so the
   * Screener hydrates and shows a held sensitive message's body exactly like every other held one.
   * `hydrateBody` no longer refuses it, and `.hm-body` renders its text rather than a block.
   */
  it("a SENSITIVE held message is fetched and shows its body — no withholding at the gate", async () => {
    /**
     * WATCHED RED by restoring `isProtectedMessage`'s live branch: the engine stops fetching and
     * the code disappears. The `.hm-body` redaction arm that used to stand beside it is gone —
     * body withholding was withdrawn and the branch rendered for nobody — so restoring the
     * predicate alone is the whole mutation now.
     */
    const engine = await engineWith([
      msg({
        id: "p1",
        from: { name: "Bank", address: "bank@example.invalid" },
        folder: "ohmail/Screener" as Folder,
        date: "2026-08-03T10:00:00.000Z",
        snippet: "Your code is 481920",
        sensitivity: {
          sensitive: true, category: "otp",
          no_ai: true, no_forward: true, no_kb: true, priority: false,
        },
      }),
    ]);
    await engine.start();
    await mountScreener(engine);

    const article = heldArticles()[0]!;
    // The engine fetches it like any other held body — the reader gets the whole message.
    expect(bodiesFetched).toContain("p1");
    // No withholding block; the fetched body renders where a stranger's mail is judged.
    expect(article.querySelector(".protected")).toBeNull();
    expect(article.querySelector(".hm-body")!.textContent).toContain("FULL BODY of p1");
  });

  it("…and an ordinary body still says it is loading — the spinner was NARROWED, not deleted", async () => {
    /**
     * The other half, and the reason the fix is a distinction rather than a deletion. This pile
     * gets full bodies by default precisely because a consent decision taken on a truncation is
     * the risk the Screener exists to remove, so while a request really is in the air the
     * preview still has to say the text is not the whole message.
     *
     * WATCHED RED by mapping every non-`full`/`failed` state to `null` — i.e. "fixing" the
     * permanent spinner by removing the sentence: both articles go silent under a snippet while
     * their bodies are still being fetched.
     */
    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });
    const engine = await engineWith(HELD, async (id) => {
      await inFlight;
      return { text: `FULL BODY of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
    });
    await engine.start();
    await mountScreener(engine);

    const notes = [...host!.querySelectorAll<HTMLElement>(".scn-mails .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("Loading the full message");
      // A wait is not a failure: no `warn`, and no Retry to press on a live request.
      expect(n.classList.contains("warn")).toBe(false);
      expect(n.querySelector("button")).toBeNull();
    }
    release();
    await act(async () => { await inFlight; });
  });

  it("…and a request that NEVER answers stops claiming it is coming, and grows a Retry", async () => {
    /**
     * THE THIRD CASE, AND THE ONE `bodyStall` CANNOT SEE. It bounds the two situations where
     * `hydrateBody` asks for nothing — a protected message, a row that has left the mirror — and
     * says nothing about a request that DEPARTS, is accepted, and never comes back. The record
     * stays `loading`, nothing further is coming to re-drive it, and this preview said the body
     * was on its way for as long as the sender stayed selected, with no control to escape it.
     *
     * That is not hypothetical here: the deadline that turns a hung body fetch into a `failed`
     * record lives in `HttpAdapter.withDeadline`, so any host reaching bodies another way — and
     * `putBody` losing both writes to a refusing IndexedDB, which is swallowed by design — leaves
     * exactly this state. Hence a bound on the SENTENCE, `useBodyStalled`, which is the same
     * mechanism the reading pane and the conversation already use rather than a second one
     * shaped like it.
     *
     * The adapter below never settles and has no deadline of its own, so nothing but the surface
     * bound can end this. WATCHED RED by deleting the `stalled` term from `failed` in `HeldMail`:
     * the note stays "Loading the full message…" through twenty-seven simulated seconds and the
     * Retry never appears — the shipped behaviour, and it never ends at any number.
     */
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const engine = await engineWith(HELD, () => new Promise<MessageBodyWire>(() => {}));
      await engine.start();
      await mountScreener(engine);

      const note = (): HTMLElement => host!.querySelector<HTMLElement>(".scn-mails .hm-state")!;
      expect(note().textContent).toContain("Loading the full message");
      expect(note().classList.contains("warn")).toBe(false);
      expect(note().querySelector("button")).toBeNull();

      // Past the engine's own fetch deadline plus its queue — the derived bound, not a number
      // chosen in the test: `BODY_STALL_MS` is imported from the surface that applies it.
      await act(async () => { await vi.advanceTimersByTimeAsync(BODY_STALL_MS + 1_000); });

      expect(
        note().textContent,
        "the held-mail preview promised a body for ever with no way out",
      ).toContain("Couldn't load the full message");
      expect(note().classList.contains("warn")).toBe(true);
      // The way out is real: `hydrateBody` refuses an automatic re-ask, so the sentence is only
      // honest if the human's re-ask is on screen beside it.
      expect(note().querySelector("button")!.textContent).toContain("Retry");
    } finally {
      vi.useRealTimers();
    }
  });
});
