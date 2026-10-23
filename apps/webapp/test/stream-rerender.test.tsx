/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, MessageBody, FeedPartition, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { KeymapProvider } from "../app/shell/keymap";
import { openingCount } from "../app/shell/stream-window";

/**
 * THE READING STREAM DOES NOT RE-RENDER A CARD WHOSE INPUTS DID NOT CHANGE.
 *
 * Reads and Receipts render a card per message and the stream is NOT windowed (only the list
 * column is — see `view-window.test.tsx`), so a mirror of N messages mounts N cards. Every `/sync`
 * apply bumps the engine version, which re-renders the view; before the memoized wrapper, that
 * re-ran the render function of all N cards on every apply, whether or not any of them changed —
 * the whole-stream re-render that pinned a browser tab at high CPU and a desktop WebView higher.
 *
 * The fix is `StreamCardMemo`: a per-message `React.memo` with a comparator keyed on the FACTS the
 * card draws (`m.id` plus the mutable bits + body primitives + stable callbacks), not on the
 * message reference. An apply that changes nothing re-renders zero cards; an apply that flips one
 * card's `current`/`expanded`/body/unread re-renders exactly that card.
 *
 * ── THE HARNESS CLONES EVERY MESSAGE ON EVERY BUMP, ON PURPOSE ─────────────────────────────────
 *
 * These views render the CONSENT PROJECTION (`presentationReader`), which returns `{ ...m }` — a
 * fresh object — for every relocated message, so a card's message reference is NOT stable across a
 * version bump. A reference memo would pass a test that reuses the object and fail in the app. So
 * the bump below rebuilds `partition` from fresh clones with identical content; a reference memo
 * (or no memo) re-renders all N, the facts comparator re-renders none — that is the discrimination.
 *
 * The count is the invariant, not a timer (a "under N ms" test flaps and gets deleted). jsdom has
 * no layout, so the clamp measurement early-returns as in `view-window.test.tsx`; this counts React
 * renders, which layout does not affect.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const N = 200;
const tags: TagDTO[] = [];

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

// A snippet body, the state every unhydrated card is in — the common case the stream is full of.
const body = (m: EngineMessage): MessageBody =>
  ({ text: m.snippet, state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

// Count every time React renders a real StreamCard. The mock replaces the export wherever the view
// places one and delegates to the real component, so a card the memo SKIPS is never counted.
const counter = { streamCards: 0 };
vi.mock("@ohmail/ui", async (importActual) => {
  const actual = await importActual<typeof import("@ohmail/ui")>();
  const Real = actual.StreamCard;
  return {
    ...actual,
    StreamCard: (props: React.ComponentProps<typeof actual.StreamCard>) => {
      counter.streamCards++;
      return React.createElement(Real, props);
    },
  };
});

// Imported AFTER the mock is registered so the view picks up the counting StreamCard.
const { ReadsView } = await import("../app/views/ReadsView");

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

/** The stable-callback envelope AppShell provides — a version bump re-derives `partition` (new
 *  arrays) over the SAME message references, exactly as `readsPartition` does on each apply. */
let bump: () => void = () => {};
let setCurrent: (id: string | null) => void = () => {};
let setJump: (id: string | null) => void = () => {};

function Harness({ msgs }: { msgs: EngineMessage[] }) {
  const [version, setVersion] = React.useState(0);
  const [cur, setCur] = React.useState<string | null>(null);
  const [jump, setJumpState] = React.useState<string | null>(null);
  bump = () => setVersion((v) => v + 1);
  setCurrent = setCur;
  setJump = setJumpState;
  const now = React.useMemo(() => new Date(ISO), []);
  const onCur = React.useCallback((id: string) => setCur(id), []);
  const bodyOf = React.useCallback((m: EngineMessage) => body(m), []);
  const hydrateBody = React.useCallback(() => {}, []);
  const onAction = React.useCallback(() => {}, []);
  const onJumped = React.useCallback(() => setJumpState(null), []);
  // New partition object each render, and FRESH CLONES of every message inside — the shape a real
  // apply takes once the consent projection (`presentationReader`) has rebuilt the pile. A memo
  // keyed on the message reference cannot survive this; the facts comparator must.
  const partition = React.useMemo<FeedPartition>(
    () => {
      const fresh = msgs.map((m) => ({ ...m }));
      return { waterline: null, fresh, seen: [], newCount: fresh.filter((m) => m.unread).length };
    },
    [msgs, version],
  );
  return (
    <ReadsView settled owed={false}
      partition={partition} tags={tags} now={now} cur={cur} onCur={onCur}
      aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
      bodyOf={bodyOf} hydrateBody={hydrateBody} jumpTo={jump} onJumped={onJumped} onAction={onAction}
    />
  );
}

async function mount(node: React.ReactNode): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>{node}</KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
}

describe("the reading stream skips cards whose inputs did not change", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    // jsdom ships no `CSS`; ReadsView's keep-in-view effect calls `CSS.escape` once a card is
    // current. Identity is enough here — no selector is matched against real layout.
    (globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= {
      escape: (s: string) => s,
    };
    // jsdom has no layout, so `scrollIntoView` is absent; the keep-in-view effect calls it once a
    // card becomes current. A no-op is enough — this test asserts render counts, not scrolling.
    (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => {};
    // …and no element scrolling: a jump's landing scroll only has to not throw here.
    (HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= () => {};
    vi.spyOn(console, "error").mockImplementation(() => {});
    counter.streamCards = 0;
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("a version bump that changes no message re-renders zero cards", async () => {
    const msgs = Array.from({ length: N }, (_, i) => message(i));
    await mount(<Harness msgs={msgs} />);
    // The stream mounts its opening run, not the pile (`stream-window.ts`; its own guards live
    // in `stream-mount-window.test.tsx`). Ignore the exact count — the invariant under test
    // here is the DELTA on a subsequent apply.
    expect(counter.streamCards).toBeGreaterThanOrEqual(Math.min(N, openingCount(window.innerHeight)));

    counter.streamCards = 0;
    await act(() => bump());
    // The load-bearing assertion: an apply that touched nothing re-renders nothing.
    expect(counter.streamCards).toBe(0);
  });

  it("a card whose TRIAGE changed re-renders, though its id did not", async () => {
    /**
     * THE PARK PRESS, and the reason this case exists.
     *
     * `m` is handed whole to the card's action bar, so `triage` is drawn by the card while
     * arriving inside `m` rather than beside it — and `m.id` cannot stand in for it, because the
     * projection clones a relocated message and a NEW object with the SAME id is exactly what a
     * triage change looks like.
     *
     * For as long as the shell's `onAction` changed identity on every render that mattered, the
     * card re-rendered for that reason and collected the fresh `m` on the way past, so the gap was
     * unreachable. Once the shell's callbacks became genuinely stable it became reachable and
     * user-visible: press Park, the mutation lands, the button does not move because the card
     * still holds the pre-mutation `m`; press again and that stale `m` reaches the handler, which
     * dispatches `set_aside` a second time instead of `none` — the message cannot be unparked from
     * the card that parked it.
     *
     * Mutating the source message and bumping is precisely what a real apply does: the harness
     * re-clones from `msgs`, the way `presentationReader` re-clones from the mirror.
     */
    const msgs = Array.from({ length: N }, (_, i) => message(i));
    await mount(<Harness msgs={msgs} />);

    counter.streamCards = 0;
    (msgs[5] as unknown as { triage: { state: string } | null }).triage = { state: "set_aside" };
    await act(() => bump());

    // Exactly the one card whose drawing changed — and the sibling case above proves the
    // comparator has not simply started re-rendering everything.
    expect(counter.streamCards).toBe(1);
  });

  it("a card the lookahead reports re-renders alone — `viewer` is in the comparator", async () => {
    /* Deep in the pile (a jump moves the window there), the mounted cards are not near; the one
       the lookahead reports flips `viewer` and is the one card that draws again. Mutation: leave
       `viewer` out of `areEqual` → zero re-renders and the card never builds its viewer. */
    const near: Array<(entries: Partial<IntersectionObserverEntry>[]) => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: (entries: Partial<IntersectionObserverEntry>[]) => void, o?: IntersectionObserverInit) {
        if (o?.rootMargin === "100% 0px") near.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const msgs = Array.from({ length: N }, (_, i) => message(i));
    await mount(<Harness msgs={msgs} />);
    await act(async () => { setJump("m150"); });
    // The jump runs on a frame after its commit; let it land.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const card = document.querySelector('.scast[data-sid="m152"]');
    expect(card, "control: the jump mounted the cards around its target").not.toBeNull();
    counter.streamCards = 0;
    await act(async () => { near.at(-1)!([{ isIntersecting: true, target: card! }]); });
    expect(counter.streamCards).toBe(1);
    counter.streamCards = 0;
    await act(async () => { near.at(-1)!([{ isIntersecting: true, target: card! }]); });
    expect(counter.streamCards, "a card already near re-rendered for being reported again").toBe(0);
    vi.unstubAllGlobals();
  });

  it("moving the cursor re-renders exactly the two cards whose `current` flipped", async () => {
    const msgs = Array.from({ length: N }, (_, i) => message(i));
    await mount(<Harness msgs={msgs} />);

    counter.streamCards = 0;
    await act(() => setCurrent("m5"));
    // m5 gains current; the previous current (the mount fallback, m0) loses it. No others.
    expect(counter.streamCards).toBeLessThanOrEqual(2);
    expect(counter.streamCards).toBeGreaterThanOrEqual(1);
  });
});
