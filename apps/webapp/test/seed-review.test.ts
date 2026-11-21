/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * THE SEED REVIEW SCREEN — the list is shown BEFORE it acts, and the button says what it does.
 *
 * Four claims, and each is one way this screen could be dishonest:
 *
 *   1. it names the people and the count before anything is written;
 *   2. it says out loud that confirming moves no mail — the promise most easily broken by an
 *      implementation that reused the Screener's decide path;
 *   3. the robot filter's removals are disclosed with their reasons, not hidden;
 *   4. the confirm posts exactly what is ticked, once, with an idempotency key.
 *
 * Mounted as the real component against a fetch mock, rather than through `AppShell`: the shell
 * decides WHEN to show it (that is `seedOwed`, and `history-view.test.ts` covers the shell's
 * partition), and what is under test here is what the screen itself says and sends.
 *
 * RE-POINTED (the switch's older tests, sorted once): the screen is the first run's own review
 * (`packages/app/src/mailboxes/first-run/SeedReview.tsx`), over the web's own wire to the same routes
 * (`CLOUD_SEED_REVIEW`, `consent-over-api.ts`) and the same fetch mock; "offered by the shell" and "opened from
 * Settings" are the stage's offer, as the stage hands it. Every expectation is as it stood.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REVIEW = {
  candidates: [
    { address: "lena@atelier.example", name: "Lena Roth", messages: 12, lastWrittenAt: null, alreadyDecided: false },
    { address: "ben@studio.example", name: null, messages: 3, lastWrittenAt: null, alreadyDecided: false },
    { address: "old@friend.example", name: null, messages: 1, lastWrittenAt: null, alreadyDecided: true },
  ],
  excluded: [
    { address: "no-reply@bank.example", reason: "robot-recipient" },
    { address: "me@trafficflow.invalid", reason: "own-address" },
  ],
  scannedMessages: 582,
  truncated: false,
};

/** What `GET /consent/seed` answers — {@link REVIEW} unless a case says otherwise. */
let reviewAnswer: unknown = REVIEW;
let posted: Array<{ body: unknown; key: string | null }> = [];
/** Set to make the next POST fail — the "confirm came back refused" path. */
let confirmFails = false;
let originalFetch: typeof globalThis.fetch;
let roots: Root[] = [];

const mount = async (
  extra: { onNothingToDecide?: () => void } = {},
): Promise<{ container: HTMLElement; done: () => number; later: () => number }> => {
  const { useSeedReview } = await import("@ohmail/app-logic/mailboxes/first-run/use-seed-review");
  const { SeedReview } = await import("../../../packages/app/src/mailboxes/first-run/SeedReview.js");
  const { sayOf } = await import("../../../packages/app/src/mailboxes/first-run/words.js");
  const { TextProvider, useTextLookup } = await import("../../../packages/app/src/text/index.js");
  const { CLOUD_SEED_REVIEW } = await import("../app/(product)/mailbox/consent-over-api.js");
  const screener = (await import("../../../packages/app/messages/screener.en.json", { with: { type: "json" } })).default;
  let doneCalls = 0;
  let laterCalls = 0;
  /* The offer as the stage hands it: offered by the shell (a hand-back when nobody is left), or opened from Settings. */
  const offer = {
    owed: true,
    reopened: extra.onNothingToDecide === undefined,
    reopen: () => {},
    later: () => { laterCalls += 1; },
    nothingToDecide: () => { extra.onNothingToDecide?.(); },
    done: () => { doneCalls += 1; },
  };
  function Review() {
    const review = useSeedReview({
      wire: CLOUD_SEED_REVIEW,
      onDone: offer.done,
      ...(offer.reopened ? {} : { onNothingToDecide: offer.nothingToDecide }),
    });
    return h(SeedReview, { review, offer, say: sayOf(useTextLookup()) });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(TextProvider, {
        locale: "en", messages: screener as never, timeZone: "UTC",
        children: h(Review, null),
      }),
    );
    await Promise.resolve();
  });
  // One more flush for the review fetch.
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return { container, done: () => doneCalls, later: () => laterCalls };
};

const text = (c: HTMLElement): string => c.textContent ?? "";
const boxes = (c: HTMLElement): HTMLInputElement[] =>
  [...c.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];

/**
 * Type into the search box the way a person does.
 *
 * `input.value = x` alone does NOT reach React: React keeps its own value tracker on the node
 * and, because the assignment updates that tracker too, it concludes nothing changed and never
 * calls `onChange`. The filter would silently stay empty, and a test of a FILTERED bulk action
 * that runs against an unfiltered list is a test of the wrong thing that still passes half the
 * time. Going through the prototype's setter is what leaves the tracker stale, which is the
 * signal React reads as "this changed".
 */
const typeSearch = async (c: HTMLElement, value: string): Promise<void> => {
  const input = c.querySelector('input[type="search"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

describe("the sent-mail seed review", () => {
  beforeEach(() => {
    reviewAnswer = REVIEW;
    posted = [];
    confirmFails = false;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/consent/seed") && (init?.method ?? "GET") === "POST") {
        posted.push({
          body: JSON.parse(String(init?.body ?? "{}")),
          key: new Headers(init?.headers).get("Idempotency-Key"),
        });
        if (confirmFails) {
          // A 500 whose body this client cannot read — which is precisely what a serverless
          // host answers when the handler dies, and what the live failure looked like.
          return new Response("<html>upstream said no</html>", {
            status: 500, headers: { "content-type": "text/html" },
          });
        }
        return new Response(
          JSON.stringify({ rulesCreated: 2, contactsCreated: 3, declined: 0, skipped: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/consent/seed")) {
        return new Response(JSON.stringify(reviewAnswer), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    await act(async () => { for (const r of roots) r.unmount(); });
    roots = [];
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("names the people and the count before writing anything", async () => {
    const { container } = await mount();
    // The kit draws a title's closing full stop as its end dot: the sentence is the same.
    expect(text(container)).toContain("3 people you wrote to");
    expect(text(container)).toContain("Lena Roth");
    expect(text(container)).toContain("ben@studio.example");
    // Nothing was posted by looking at the list. The list is an offer.
    expect(posted).toHaveLength(0);
  });

  it("SAYS EXACTLY WHAT MOVES, before the button is pressed", async () => {
    const { container } = await mount();
    // It used to say "it doesn't move any mail", and the confirmation now releases what the
    // Screener is holding from those people — mail waiting for this very decision. A claim a
    // shipping feature makes false is fixed in the same change, so the sentence names the one
    // thing that moves AND the promise that has not changed: nothing else is touched.
    expect(text(container)).toContain("waiting in the Screener moves to your Ohbox");
    expect(text(container)).toContain("stays where your mail server has it");
    expect(text(container)).not.toContain("doesn't move any mail");
  });

  it("discloses what the robot filter removed, and why", async () => {
    const { container } = await mount();
    expect(text(container)).toContain("2 addresses were left out");
    expect(text(container)).toContain("no-reply@bank.example");
    expect(text(container)).toContain("looks like a machine address");
    expect(text(container)).toContain("one of your own addresses");
  });

  it("posts exactly what is ticked — once, with a key", async () => {
    const { container, done } = await mount();

    // Everyone undecided starts ticked; the one already decided about is shown but locked.
    const checks = boxes(container);
    expect(checks.filter((b) => b.checked)).toHaveLength(2);
    expect(checks.filter((b) => b.disabled)).toHaveLength(1);

    // Untick Ben. The button restates the number, so the count is never implicit.
    await act(async () => { checks[1]!.click(); await Promise.resolve(); });
    expect(text(container)).toContain("Let 1 in");

    const confirm = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Let 1 in");
    expect(confirm).toBeTruthy();
    await act(async () => { confirm!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual({ addresses: ["lena@atelier.example"] });
    // A press of a button, keyed — so a retry after a lost response replays the answer rather
    // than asking a question the server now refuses.
    expect(posted[0]!.key, "the confirm carried no Idempotency-Key").toBeTruthy();
    expect(done()).toBe(1);
  });

  /**
   * A FAILED CONFIRM MUST NOT COST THE USER THEIR CURATION.
   *
   * Going down hundreds of names and unticking a dozen is real work that exists nowhere but in
   * this component's state. The screen used to replace itself with an apology, so a transient
   * 500 — and the live one WAS transient, a database counter that had drifted — threw away
   * every decision the person had made and asked them to make all of them again.
   */
  it("keeps every tick when the confirm fails, and sends the same list on the retry", async () => {
    const { container } = await mount();
    const checks = boxes(container);
    await act(async () => { checks[1]!.click(); await Promise.resolve(); });   // untick Ben

    confirmFails = true;
    const press = (): HTMLButtonElement | undefined =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "Let 1 in") as HTMLButtonElement | undefined;
    await act(async () => { press()!.click(); await Promise.resolve(); await Promise.resolve(); });

    // The list is still on screen — not an apology card — and it still knows who was unticked.
    expect(text(container)).toContain("Lena Roth");
    expect(text(container)).toContain("Your ticks are still here");
    const afterFailure = boxes(container);
    expect(afterFailure[0]!.checked).toBe(true);
    expect(afterFailure[1]!.checked, "the untick was lost by the failure").toBe(false);

    // …and pressing again sends exactly what the failed press sent.
    confirmFails = false;
    await act(async () => { press()!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.body).toEqual({ addresses: ["lena@atelier.example"] });
    // A separate key per press: the second press is a new question, not a replay of the first.
    expect(posted[0]!.key).not.toBe(posted[1]!.key);
  });

  it("ticks and unticks everything the search is showing, and nothing it is not", async () => {
    const { container } = await mount();

    // Narrow to the two `@studio.example` rows. One of them is already decided about, so it is
    // never actionable; `lena@atelier.example` is simply not shown.
    await typeSearch(container, "studio");
    expect(text(container)).toContain("ben@studio.example");
    expect(text(container)).not.toContain("lena@atelier.example");

    const untickShown = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "None");
    expect(untickShown, "no bulk untick was offered under a filter").toBeTruthy();
    await act(async () => { untickShown!.click(); await Promise.resolve(); });

    // Lena is off screen and MUST still be ticked: a bulk control that reaches past the filter
    // is the one that silently destroys a curated list.
    await typeSearch(container, "");
    const after = boxes(container);
    expect(after[0]!.checked, "Lena was unticked by a filtered bulk action").toBe(true);
    expect(after[1]!.checked).toBe(false);
    expect(text(container)).toContain("Let 1 in");

    // And the other direction puts them back.
    const tickAll = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "All");
    await act(async () => { tickAll!.click(); await Promise.resolve(); });
    expect(text(container)).toContain("Let 2 in");
  });

  it("'Not now' writes nothing at all", async () => {
    const { container, later } = await mount();
    const skip = [...container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("Not now"));
    await act(async () => { skip!.click(); await Promise.resolve(); });
    expect(posted).toHaveLength(0);
    expect(later()).toBe(1);
  });

  /* NO DECISION OVER ZERO PEOPLE. A mailbox whose sent mail names nobody new — none written to,
     or every one already decided — used to take the stage with "You've written to 0 people" and
     "Let 0 people through". Offered by the shell, the review hands the stage back; opened from
     Settings, it says so in one sentence and offers no confirm. */
  describe("with nobody to decide about", () => {
    const NOBODY = { candidates: [], excluded: [], scannedMessages: 0, truncated: false };
    const ALL_DECIDED = {
      ...REVIEW,
      candidates: [{ address: "old@friend.example", name: null, messages: 1, lastWrittenAt: null, alreadyDecided: true }],
    };

    it("offered by the shell: hands the stage back and draws no decision", async () => {
      reviewAnswer = NOBODY;
      let handed = 0;
      const { container } = await mount({ onNothingToDecide: () => { handed += 1; } });
      expect(handed, "the review kept the stage over nobody").toBe(1);
      expect(text(container)).not.toContain("0 people");
      expect(container.querySelectorAll("button")).toHaveLength(0);
    });

    it("…and the same when everyone written to is already decided", async () => {
      reviewAnswer = ALL_DECIDED;
      let handed = 0;
      const { container } = await mount({ onNothingToDecide: () => { handed += 1; } });
      expect(handed).toBe(1);
      expect(text(container)).not.toContain("Let 0 in");
    });

    it("opened from Settings: one sentence and a way out, no confirm", async () => {
      reviewAnswer = NOBODY;
      const { container, later } = await mount();
      expect(text(container)).toContain("Nobody in your sent mail is waiting for a decision.");
      expect(text(container)).not.toContain("0 people");
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.map((b) => b.textContent)).toEqual(["Close"]);
      await act(async () => { buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(later()).toBe(1);
      expect(posted).toHaveLength(0);
    });
  });
});
