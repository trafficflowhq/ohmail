/** @vitest-environment jsdom */
/**
 * B.3 GUARD — HYDRATE ON VIEWPORT INTENT, NOT THE PILE.
 *
 * Reads rendered the raw text dump because the cards' bodies were never fetched. The fix hydrates
 * a card as it nears the fold — one IntersectionObserver in `StreamShell`, `onNear` wired to
 * `hydrateBody` — and it MUST stay per-card: a pile-wide prefetch is exactly the API cost with no
 * revenue behind it that the "No API cost without revenue behind it" invariant forbids.
 *
 * jsdom has no real IntersectionObserver, so this stubs one that DELIVERS every observed card but
 * marks only the first N as `isIntersecting`. The near effect filters on `isIntersecting`, so a
 * correct implementation hydrates exactly those N and never the seen tail. Mutate the effect to
 * fire for every delivered entry (drop the `isIntersecting` check / "loop all") and the seen-tail
 * assertion goes red — the guard is watched, not decorative.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type IOEntry = { target: Element; isIntersecting: boolean };

/** Captures every observer; the NEAR one is the only one whose rootMargin is a percentage. */
class MockIO {
  static all: MockIO[] = [];
  cb: (entries: IOEntry[]) => void;
  rootMargin: string;
  observed: Element[] = [];
  constructor(cb: (entries: IOEntry[]) => void, options?: IntersectionObserverInit) {
    this.cb = cb;
    this.rootMargin = options?.rootMargin ?? "";
    MockIO.all.push(this);
  }
  observe(el: Element): void { this.observed.push(el); }
  unobserve(): void {}
  disconnect(): void { this.observed = []; }
}

function msg(id: string, unread: boolean): Record<string, unknown> {
  return {
    id,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `S-${id}`,
    from: { name: id, address: `${id}@example.com` },
    to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z",
    folder: "ohmail/News",
    snippet: "preview",
    unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hydrated: string[] = [];

const FRESH = ["f0", "f1", "f2", "f3", "f4"];
const SEEN = ["s0", "s1", "s2", "s3"];

async function mount(): Promise<void> {
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const now = new Date("2026-08-02T09:00:00.000Z");
  const tree = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now,
    children: h(KeymapProvider as never, {
      children: h(ReadsView as never, {
    settled: true, owed: false,
        partition: {
          waterline: { meta: "last visit" },
          fresh: FRESH.map((id) => msg(id, true)),
          seen: SEEN.map((id) => msg(id, false)),
        },
        tags: [],
        now,
        cur: null,
        onCur: () => {},
        aiChip: null,
        chipState: null,
        onChipState: () => {},
        markSeen: () => {},
        isSeen: (m: { unread: boolean }) => !m.unread,
        bodyOf: (m: { body?: string; snippet: string }) => ({
          text: m.body ?? m.snippet,
          state: m.body !== undefined ? "full" : "snippet",
          html: null,
          loadedRemoteContent: false,
          unsubscribe: "no_header",
          unsubscribeUrl: null,
        }),
        hydrateBody: (id: string) => { hydrated.push(id); },
        jumpTo: null,
        onJumped: () => {},
      } as never),
    } as never),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(tree); });
}

beforeEach(() => {
  MockIO.all = [];
  vi.stubGlobal("IntersectionObserver", MockIO);
  hydrated = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.unstubAllGlobals();
});

describe("Reads hydrates on viewport intent, never the pile (B.3)", () => {
  it("fires hydrateBody for exactly the near cards, and none of the seen tail", async () => {
    await mount();

    // The lookahead observer reaches one whole viewport up and down: a collapsed card settles
    // once when its body lands (348 is a ceiling), so that landing has to happen off screen.
    const near = MockIO.all.find((io) => io.rootMargin === "100% 0px");
    expect(near).toBeDefined();

    // It observes the WHOLE stream — fresh + seen — but only the first three have neared the
    // fold. Deliver all of them; only those three carry `isIntersecting`.
    const cards = near!.observed.filter((el) => (el as HTMLElement).dataset.sid);
    const N = 3;
    await act(async () => {
      near!.cb(cards.map((el, i) => ({ target: el, isIntersecting: i < N })));
    });

    const near3 = cards.slice(0, N).map((el) => (el as HTMLElement).dataset.sid);
    // Every card the near observer fired for was one of the first three.
    for (const id of near3) expect(hydrated).toContain(id);
    // The seen tail was observed but NOT intersecting — it must never be hydrated.
    for (const id of SEEN) expect(hydrated).not.toContain(id);
    // …and nothing outside the reported near set leaked in beyond the current-card fetch (f0).
    const allowed = new Set([...near3, "f0"]);
    for (const id of hydrated) expect(allowed.has(id!)).toBe(true);
  });
});
