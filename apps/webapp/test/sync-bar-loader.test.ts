/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import { DRAIN_MARK_HOLD_MS, markDrain } from "@ohmail/app-logic/session/drain-mark";

/**
 * THE STRIP'S LOADER — the busy states must show that something is running.
 *
 * ── WHAT THIS FILE HAS TO BITE ──────────────────────────────────────────────────────────
 *
 * Reported from live use on a large mailbox: "Syncing your mail.
 * N messages so far" with no loader. Between drains — up to eight seconds — NOTHING on the
 * strip moves, so a state that is working is indistinguishable from a state that has hung. The
 * count is the only moving part and it moves too rarely to read as liveness.
 *
 * So `importing` and `awaiting` — the two states that report WORK — carry a spinner, and the
 * states that report a CONDITION (`blocked`, `mailboxError`, `stopped`, `failing`) must not:
 * a spinner on a blocked mailbox would claim progress that is not happening, which is the
 * same class of defect one notch louder.
 *
 * ── AND SINCE 0.19.2 THE SPINNER MEANS A DRAIN, NOT A STATE ─────────────────────────────
 *
 * A busy STATE can stand for hours; what the mark claims is that something is running now, so it
 * is mounted by the drain the loop publishes (`drain-mark.ts`). The reported defect stays fixed,
 * because an import is one drain that loops internally while `hasMore` — the mark is up for the
 * whole of it. What is gone is the mark standing over a settled mailbox between drains, which is
 * a claim nothing was backing and which cost about 1.7 cores a window to make (PERFORMANCE.md §G).
 * Every case below therefore renders with a drain in flight, and the last one pins the other
 * half.
 *
 * INDETERMINATE, never a percentage — and that survives the arrival of a real total. `/sync`
 * answers `hasMore` as a boolean, so the shape of a drain is still unknowable mid-import; what
 * `MailState.total` carries is the ACCOUNT's message count, measured elsewhere on another clock.
 * Two numbers may be QUOTED side by side ("N of M" reads as two measurements, which is
 * what it is); a filled track or a percentage would claim one continuous progression nobody can
 * see, so the assertions below still refuse them.
 *
 * ── WHY THE PROVIDER IS MOCKED ──────────────────────────────────────────────────────────
 *
 * `SyncBar` is a switch over a key somebody else derived — it decides nothing. The ladder that
 * derives the key has its own guards in `mail-state.test.ts` and the wiring has its own in
 * `sync-progress.test.ts`; driving the full shell here would test those again and would make
 * the six states expensive to enumerate. What is under test is the RENDER, per key.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet",
  clock: false,
  count: 0,
  total: null,
  reason: null,
  errorCode: null,
  asOf: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  pending: 0,
  // The filing report — `null` is the resting value and means the arm has not fired.
  filing: null,
  continuesAtFolder: null,
  settled: true,
  owed: false,
};

/** What the mocked provider will hand back on the next render. */
let current: MailState = QUIET;

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

const roots: Root[] = [];
afterEach(() => {
  roots.forEach((r) => r.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
});

async function render(state: MailState, variant?: "rail"): Promise<HTMLElement> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-04T00:00:00.000Z"),
        children: variant ? h(SyncBar, { variant }) : h(SyncBar, null),
      }),
    );
  });
  return container;
}

const spinner = (c: HTMLElement) => c.querySelector(".mbx-spin");
const glyph = (c: HTMLElement) => c.querySelector(".glyph");

/* A drain is in flight for every case in this file except the one that says what happens when
   there is not. Set before the render: the mark is a plain store the strip reads. */
beforeEach(() => { markDrain(true); });

describe("the busy states show that something is running", () => {
  it("importing renders an indeterminate spinner, not a static envelope", async () => {
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 8824 });
    expect(spinner(c), "the importing strip had no loader — a climbing count is the only motion")
      .not.toBeNull();
    expect(glyph(c), "the importing strip kept the static ✉ as well as the spinner").toBeNull();
  });

  it("awaiting renders one too — it is the state with NO count to move at all", async () => {
    const c = await render({ ...QUIET, key: "awaiting", clock: true, minutes: 4 });
    expect(spinner(c), "the awaiting strip had no loader").not.toBeNull();
    expect(glyph(c), "the awaiting strip kept the static ✉").toBeNull();
  });

  it("the spinner is hidden from the accessibility tree", async () => {
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 8824 });
    expect(
      spinner(c)!.getAttribute("aria-hidden"),
      "an indeterminate spinner with no value was left announceable inside a role=status region",
    ).toBe("true");
  });

  it("and with nothing in flight there is no mark at all — the state alone does not move", async () => {
    // The other half of the rule, in the file that owns the first half: the same importing state,
    // the same render, with the drain settled and its quiet window run out.
    vi.useFakeTimers();
    markDrain(false);
    vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
    vi.useRealTimers();
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 8824 });
    expect(spinner(c), "a mark stood over a drain that was not running").toBeNull();
    expect(glyph(c), "the strip lost its leading mark entirely").not.toBeNull();
    expect(c.textContent, "the sentence went with the mark").toContain("8,824");
  });

  it("the count is still rendered, and still without a percentage", async () => {
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 8824 });
    expect(c.textContent, "the count was lost when the loader landed").toContain("8,824");
    expect(c.textContent, "a percentage was invented for a total the client cannot know")
      .not.toMatch(/\d+\s?%/);
  });
});

describe("the account's own total, when the client has one", () => {
  it("importing quotes the pair — 1,114 of 1,541 — and still no percentage", async () => {
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 1114, total: 1541 });
    expect(c.textContent, "the pair was not rendered").toContain("1,114 of 1,541");
    expect(c.textContent, "a percentage was invented from the two numbers").not.toMatch(/\d+\s?%/);
    expect(spinner(c), "the importing strip lost its loader once it had a total").not.toBeNull();
  });

  it("without a total it says exactly what it said before — the browser tab's case", async () => {
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 8824 });
    expect(c.textContent).toContain("8,824" + " messages so far");
    expect(c.textContent).not.toContain(" of ");
  });

  it("importing is the ONLY key that may quote a total, and `quiet` renders nothing at all", async () => {
    // There was a second consumer — the `behind` state, an amber warning triangle standing on the
    // rail for as long as the mirror was short of the account ("This device holds M of the
    // account's N messages"). Removed 2026-08-30: a windowed copy in front of working
    // reach-past doors is this product behaving correctly, and an alarm over a healthy state
    // teaches people to ignore the alarms that mean something. The fact now lives on the
    // Mailboxes pane; see `desktop-mailboxes.test.ts`.
    //
    // The mutation this bites: hand `quiet` a count and a total, as the removed state used to be
    // handed them, and assert the strip stays empty. Re-add any arm that renders a resting pair
    // and this goes red.
    const c = await render({ ...QUIET, key: "quiet", count: 5107, total: 73525 });
    expect(c.textContent ?? "", "a resting shortfall was rendered on the strip").toBe("");
    expect(c.textContent ?? "").not.toContain("5,107");
    expect(c.textContent ?? "").not.toContain("73,525");
  });
});

describe("the warning triangle is reserved for FAULTS", () => {
  /* The removal's other half. `⚠` used to appear over a mirror where nothing had gone wrong, in
     every view, permanently — which is exactly how a mark stops meaning anything. Every state that
     still carries it is one where something is genuinely broken and a person can act on it. */
  const faults: Array<[string, MailState]> = [
    ["stopped", { ...QUIET, key: "stopped" }],
    ["failing", { ...QUIET, key: "failing" }],
    ["blocked", { ...QUIET, key: "blocked", clock: true, reason: "at_capacity", address: "a@b.c", minutes: 3 }],
    ["mailboxError", { ...QUIET, key: "mailboxError", errorCode: "auth", address: "a@b.c" }],
  ];

  it.each(faults)("%s keeps the mark", async (name, state) => {
    const c = await render(state);
    expect(c.textContent ?? "", `${name} lost the warning mark`).toContain("⚠");
  });

  const calm: Array<[string, MailState]> = [
    ["importing", { ...QUIET, key: "importing", clock: true, count: 5107, total: 73525 }],
    ["awaiting", { ...QUIET, key: "awaiting", clock: true, minutes: 4 }],
    ["catchingUp", { ...QUIET, key: "catchingUp" }],
    ["filing", { ...QUIET, key: "filing", pending: 12, address: "a@b.c" }],
    ["noMailbox", { ...QUIET, key: "noMailbox" }],
    ["quiet", { ...QUIET, key: "quiet", count: 5107, total: 73525 }],
  ];

  it.each(calm)("%s carries no mark", async (name, state) => {
    const c = await render(state);
    expect(c.textContent ?? "", `${name} rendered a warning over a state where nothing is wrong`)
      .not.toContain("⚠");
  });
});

describe("the condition states must NOT claim progress", () => {
  const conditions: Array<[string, MailState]> = [
    ["blocked", { ...QUIET, key: "blocked", clock: true, address: "a@b.c", minutes: 3 }],
    ["mailboxError", { ...QUIET, key: "mailboxError", errorCode: "auth", address: "a@b.c" }],
    ["stopped", { ...QUIET, key: "stopped" }],
    ["failing", { ...QUIET, key: "failing" }],
    ["noMailbox", { ...QUIET, key: "noMailbox" }],
  ];

  it.each(conditions)("%s shows no spinner", async (name, state) => {
    const c = await render(state);
    expect(spinner(c), `${name} rendered a spinner — it claims work that is not happening`)
      .toBeNull();
    expect(glyph(c), `${name} lost its glyph`).not.toBeNull();
  });
});

/**
 * THE RAIL FORM.
 *
 * The line moved into the rail, above the dock, and the strip stayed for the widths where the
 * rail is a closed drawer. Two shapes, ONE derivation: what these assert is that the rail form
 * says the same thing the strip says, in the rail's own vocabulary — because a second switch
 * over the same seven states is precisely how the two would come to disagree about what a
 * blocked mailbox is called.
 */
describe("the rail carries the same sentence, in the rail's shape", () => {
  it("renders the rail form and NOT the strip", async () => {
    const c = await render({ ...QUIET, key: "importing", clock: true, count: 8824 }, "rail");
    expect(c.querySelector(".rail-sync"), "the rail slot rendered no line at all").not.toBeNull();
    expect(
      c.querySelector(".sync-bar"),
      "the rail slot rendered the full-width strip — two shapes of one fact, both on screen",
    ).toBeNull();
  });

  it("says the same words, and keeps the count that moves", async () => {
    const strip = await render({ ...QUIET, key: "importing", clock: true, count: 8824 });
    const rail = await render({ ...QUIET, key: "importing", clock: true, count: 8824 }, "rail");
    expect(rail.querySelector(".rs-line b")!.textContent, "the two shapes named the state differently")
      .toBe(strip.querySelector("b")!.textContent);
    expect(rail.textContent, "the count was dropped from the compact form").toContain("8,824");
  });

  it("gives the busy states a progress line, and the conditions none", async () => {
    const busy = await render({ ...QUIET, key: "awaiting", clock: true, minutes: 4 }, "rail");
    expect(busy.querySelector(".rs-track"), "a running sync showed no progress at all").not.toBeNull();
    expect(
      busy.querySelector(".rs-track")!.getAttribute("aria-hidden"),
      "an indeterminate track was left announceable inside a role=status region",
    ).toBe("true");
    expect(busy.textContent, "a percentage was invented for a total the client cannot know")
      .not.toMatch(/\d+\s?%/);

    const blocked = await render(
      { ...QUIET, key: "blocked", clock: true, address: "a@b.c", minutes: 3 },
      "rail",
    );
    expect(
      blocked.querySelector(".rs-track"),
      "a blocked mailbox drew a progress line — it claims work that is not happening",
    ).toBeNull();
  });

  it("keeps the remedy reachable — the link is not lost to the compact shape", async () => {
    const c = await render({ ...QUIET, key: "mailboxError", errorCode: "auth", address: "a@b.c" }, "rail");
    expect(
      c.querySelector<HTMLAnchorElement>(".rail-sync a")?.getAttribute("href"),
      "the rail form dropped the one thing a reader can do about it",
    ).toBe("#/settings/mailboxes");
  });

  it("opens the Mailboxes pane its label names, on every door the strip runs on", async () => {
    // R23-04: the link read "Settings → Mailboxes" and landed on General. Followed through the
    // router, not compared as a string: the pane the person lands on is the behaviour.
    const { parseHash } = await import("../app/shell/routing.js");
    const c = await render({ ...QUIET, key: "noMailbox" }, "rail");
    const href = c.querySelector<HTMLAnchorElement>(".rail-sync a")?.getAttribute("href") ?? "";
    expect(parseHash(href).settingsPane, `the link ${href} opened a different pane`).toBe("mailboxes");
  });

  it("stays silent while healthy, exactly as the strip does", async () => {
    const c = await render(QUIET, "rail");
    expect(c.querySelector(".rail-sync"), "the rail spoke while healthy").toBeNull();
  });
});

describe("quiet stays silent", () => {
  it("renders nothing at all", async () => {
    const c = await render(QUIET);
    expect(c.querySelector(".sync-bar"), "the strip spoke while healthy").toBeNull();
  });
});

/**
 * THE `filing` STRIP, AND THE ONE THING IT HAS TO OFFER BESIDES A SENTENCE.
 *
 * "We have filed this mail; your mail server has not applied it yet" is only worth saying if the
 * reader can do something when it stops being temporary. It is not temporary when the mail host
 * is refusing connections — the worker's cycle throws, the backlog stops draining, and the row
 * eventually reaches `status='error'` (proven end to end in
 * `apps/worker/test/mailbox-failure.e2e.test.ts`, mid-cycle ECONNREFUSED). Until it does, this
 * strip is the only thing on screen that knows anything is wrong, and Settings → Mailboxes is
 * where the mailbox's own state and its reconnect live.
 *
 * A BUSY tone and not a warning, deliberately: the handoff between the API and the worker is
 * how every filing works, so a few seconds of backlog is the normal shape of a successful
 * decision. A warning triangle on the ordinary case is how people learn to ignore the one that
 * matters.
 *
 * WATCHED TO FAIL: dropping `link: settings` from the `filing` arm turns the link assertion red;
 * switching the tone to `warn` turns the spinner assertion red.
 */
describe("the filing strip says what is outstanding and offers the way to fix it", () => {
  const filing = (over: Partial<MailState> = {}): MailState =>
    ({ ...QUIET, key: "filing", clock: true, count: 495, pending: 12, address: "a@b.c", ...over });

  it("states the COUNT of outstanding filings, and says they are on the mail server", async () => {
    const c = await render(filing());
    expect(c.textContent).toContain("12");
    // The load-bearing clause. The mail HAS moved in ohmail — the user watched it — so "Filing
    // 12 messages" on its own reads as a lie about something they can see is already done.
    expect(c.textContent, "the strip did not say WHERE the work is outstanding").toContain("mail server");
  });

  it("LINKS Settings → Mailboxes, which is the only retry a person has", async () => {
    const c = await render(filing());
    const link = [...c.querySelectorAll("a")].find((a) => a.getAttribute("href") === "#/settings/mailboxes");
    expect(link, "a backlog that may never drain was reported with nothing to do about it").toBeTruthy();
    expect(link!.textContent).toContain("Mailboxes");
  });

  it("is BUSY, not a warning — the handoff is how every filing works", async () => {
    const c = await render(filing());
    expect(spinner(c), "the filing strip claimed nothing was in flight").not.toBeNull();
    expect(glyph(c), "the filing strip kept the static ✉ as well as the spinner").toBeNull();
  });

  it("names the mailbox when it is about exactly one, and stays silent when it is not", async () => {
    expect((await render(filing())).textContent).toContain("a@b.c");
    // Account-wide totals do not get one mailbox's address beside them — see the ladder's own
    // note. `null` is what `deriveMailState` publishes for a sum across two mailboxes.
    expect((await render(filing({ address: null }))).textContent).not.toContain("a@b.c");
  });
});

describe("an unreachable server on the strip", () => {
  it("says the Settings pane's sentence, never 'Sync failed', and names the mailbox", async () => {
    const c = await render({
      ...QUIET, key: "mailboxError", errorCode: "connect", unreachable: true,
      address: "offline@trafficflow.invalid",
    });
    expect(c.textContent).toContain(messages.sync.unreachable);
    expect(c.textContent).not.toContain(messages.mailboxes.err_connect);
    expect(c.textContent).toContain("offline@trafficflow.invalid");
    // The control: a settled connect error from another door keeps its own sentence.
    const other = await render({ ...QUIET, key: "mailboxError", errorCode: "connect", address: "x@trafficflow.invalid" });
    expect(other.textContent).toContain(messages.mailboxes.err_connect);
  });
});
