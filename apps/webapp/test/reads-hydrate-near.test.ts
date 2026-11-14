/** @vitest-environment jsdom */
/**
 * B.3 GUARD — HYDRATE ON VIEWPORT INTENT, NOT THE PILE.
 *
 * Reads rendered the raw text dump because the cards' bodies were never fetched. The fix hydrates
 * a card as it nears the fold — one IntersectionObserver on the registered stream cards, wired to
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
import { act, cleanup } from "@testing-library/react";
import { waterlineIdOf } from "@ohmail/client-engine";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";

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

let hydrated: string[] = [];
const FRESH = ["f0", "f1", "f2", "f3", "f4"];
const SEEN = ["s0", "s1", "s2", "s3"];

async function mount(): Promise<void> {
  const letters = [...FRESH, ...SEEN].map((id, index) =>
    issue(id, 20 - index, { body: undefined, unread: FRESH.includes(id) }),
  );
  const { mail } = mountStreamFrame({
    at: "#/reads/m/f0",
    letters,
    rows: { [`view_meta:${waterlineIdOf("reads")}`]: { newestSeenId: SEEN[0] } },
  });
  hydrated = mail.bodyAsks;
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLElement.prototype.scrollTo ??= function () {} as typeof HTMLElement.prototype.scrollTo;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  MockIO.all = [];
  vi.stubGlobal("IntersectionObserver", MockIO);
  hydrated = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Reads hydrates on viewport intent, never the pile (B.3)", () => {
  it("fires hydrateBody for exactly the near cards, and none of the seen tail", async () => {
    await mount();

    // The lookahead observer reaches one whole viewport up and down: a collapsed card settles
    // once when its body lands (348 is a ceiling), so that landing has to happen off screen.
    expect(document.querySelectorAll("[data-stream-item]").length).toBe(FRESH.length + SEEN.length);
    const near = MockIO.all.find((io) => io.rootMargin === "100% 0px");
    expect(near).toBeDefined();

    // It observes the WHOLE stream — fresh + seen — but only the first three have neared the
    // fold. Deliver all of them; only those three carry `isIntersecting`.
    const cards = near!.observed.filter((el) => (el as HTMLElement).dataset.streamItem);
    expect(cards.map((el) => (el as HTMLElement).dataset.streamItem)).toEqual([...FRESH, ...SEEN]);
    const N = 3;
    await act(async () => {
      near!.cb(cards.map((el, i) => ({ target: el, isIntersecting: i < N })));
    });

    const near3 = cards.slice(0, N).map((el) => (el as HTMLElement).dataset.streamItem);
    // Every card the near observer fired for was one of the first three.
    for (const id of near3) expect(hydrated).toContain(id);
    // The seen tail was observed but NOT intersecting — it must never be hydrated.
    for (const id of SEEN) expect(hydrated).not.toContain(id);
    // …and nothing outside the reported near set leaked in beyond the current-card fetch (f0).
    const allowed = new Set([...near3, "f0"]);
    for (const id of hydrated) expect(allowed.has(id!)).toBe(true);
  });
});
