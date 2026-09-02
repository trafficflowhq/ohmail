/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * ═══ "ORGANIZE HERE INSTEAD" — THE EXIT FROM READING SOMEBODY ELSE'S MAILBOX ══════════════
 *
 * Measured on the released 0.13.2 AppImage against a real
 * mailbox whose `ohmail/_meta` carried a 25-minute-stale local claim: the install stood down
 * (`verdict=available`, `organized_elsewhere:local`, `heldBy=zorin-9950`) and had **no way back at
 * all**. Three exits were walked and all three are closed:
 *
 *  1. This pane rendered NO control on a `disabled` row.
 *  2. The remedy the pane's own comment named — reconnect the address — goes through the door
 *     chooser and is refused with *"This mailbox is disconnected. Reconnect it before setting new
 *     credentials."*, whose own invariant is that a disabled mailbox holds no credential. The
 *     instruction was circular.
 *  3. The authorized takeover existed on the Cloud webapp only; `en.json` carried no takeover
 *     string for this surface at all.
 *
 * The asymmetry was measured live in one mailbox inside ten minutes: at 15:05 the desktop could
 * not take the stale claim; by 15:14 `ohmail-cloud:production` had. Retire a machine, install on
 * another, and that mailbox could never be organized again without deleting a message from an IMAP
 * folder by hand.
 *
 * `verdict=available` is NOT the defect and is not changed: becoming an organizer always requires
 * an explicit human action, which is exactly why a crashed machine's mailbox is not seized. What
 * was missing is the action. This file is the assertion that it is on screen, that it is offered
 * for a STAND-DOWN and not for a removal, that it is the local door's alone, and that it says what
 * actually has to happen next.
 *
 * ── AND THE ROW IT WAS OFFERED ON WAS THE WRONG ONE, WHICH IS WHY THIS FILE MOVED ───────────
 *
 * The control was gated on `status === "disabled" && disabledReason` — a stand-down as the OLD
 * schema encoded it, and the shape these fixtures used to carry. The role is its own column now:
 * the migration's backfill moved every stood-down row to `status='connected',
 * organizer_role='reader'`, because **a reader is connected and syncing** — that is the whole
 * point of splitting the connection from the role. So the old guard named a state nothing writes
 * any more, AND `organizeHere` REFUSES a `disabled` row, which is a tombstone. The control was
 * offered on exactly the set the handler declines.
 *
 * It is the banner's action now, stated where the fact is. The fixtures below carry the shape the
 * server actually sends.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop `!cloud` from `claimable`                 → the hosted case goes red (a claim offered on
 *    a mirror this install does not own, whose route the hosted door does not even serve);
 *  · drop `m.status !== "disabled"`                 → the tombstone case goes red, which is the one
 *    that matters: offering a claim on a removal resurrects a mailbox somebody deliberately took
 *    off this machine, and the handler refuses it anyway;
 *  · make `claimable` test `organizerRole !== "reader"` → the organizer case goes red (a claim
 *    banner over a mailbox this machine already organizes);
 *  · post to `/mailboxes/:id/organize` instead      → the route case goes red (that is the
 *    ACCOUNT's ceremony; this door's authority is the machine's own login).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let FACTS: MailboxFacts[] | null = null;
let refreshed = 0;

vi.mock("../../webapp/app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: { key: "quiet", clock: false, settled: true },
    mailboxes: FACTS,
    mirrored: 0,
    freshness: { state: "current" },
    refresh: () => { refreshed += 1; },
  }),
}));

/** Every request the pane put down the pipe, in order — the route is half of what is under test. */
let bridged: { url: string; method: string; body?: string }[] = [];
let bridgeReply: () => Response = () =>
  new Response(JSON.stringify({ outcome: "authorized", previousReason: "organized_elsewhere:local" }),
    { status: 200, headers: { "content-type": "application/json" } });

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async (url: string, init?: { method?: string; body?: string }) => {
    bridged.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
    return bridgeReply();
  },
}));

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: unknown, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/**
 * A mailbox ANOTHER INSTALL ORGANIZES, in the shape the server sends: `connected` — because a
 * reader reads, searches and marks seen exactly like any other mail client — with the role and the
 * holder in their own columns.
 */
const READER: MailboxFacts = {
  id: "mbx-reader",
  address: "owner@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-01T13:05:00.000Z",
  initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "zorin-9950", since: "2026-08-28T09:00:00.000Z" },
  organizerState: "held",
};

/** This install organizes it. Nothing to claim, and a banner here would be a lie about the row. */
const ORGANIZER: MailboxFacts = {
  ...READER, id: "mbx-mine", organizerRole: "organizer", organizedBy: null, organizerState: null,
};

/** A TOMBSTONE — removed from this machine. The handler refuses it and so must the pane. */
const REMOVED: MailboxFacts = { ...READER, id: "mbx-removed", status: "disabled", organizerRole: "reader" };

/** `unknown` is a LEGAL holder kind, and a reader may carry no holder name at all. */
const UNKNOWN_HOLDER: MailboxFacts = {
  ...READER, id: "mbx-unknown",
  organizedBy: { kind: "unknown", name: null, since: "2026-08-28T09:00:00.000Z" },
};

/** A LIVE CLOUD holder. `decideLease` rule 5 refuses a local install over this one, authorized or not. */
const CLOUD_HELD: MailboxFacts = {
  ...READER, id: "mbx-cloud",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-28T09:00:00.000Z" },
  organizerState: "held",
};

/** A cloud holder that has STOPPED renewing — rules 7-8 leave the request free to win. */
const CLOUD_STOPPED: MailboxFacts = { ...CLOUD_HELD, id: "mbx-cloud-quiet", organizerState: "stopped" };

/** A stand-down as an engine PREDATING the role column reports one: no role, `disabled` + reason. */
const LEGACY_STAND_DOWN: MailboxFacts = {
  ...READER, id: "mbx-legacy",
  status: "disabled", disabledReason: "organized_elsewhere:local",
  organizerRole: undefined, organizedBy: null, organizerState: null,
  legacyStandDown: true,
};

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

/** The tree, as a node — so a case can re-render the SAME root over changed facts, which is how
 *  the pane sees a poll land. */
async function paneNode(door: string | null): Promise<React.ReactElement> {
  const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
  return h(
    IntlProvider,
    { locale: "en", messages: messages as never, timeZone: "UTC" },
    h(
      ThemeProvider,
      { storageKey: "ohmail.theme" },
      h(ToastHost, null, h(DesktopMailboxes, { door })),
    ),
  ) as React.ReactElement;
}

async function render(door: string | null): Promise<HTMLElement> {
  const node = await paneNode(door);
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => { root!.render(node); });
  return mountPoint;
}

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)) ?? null
  );
}

const organizeButton = (el: HTMLElement) => buttonSaying(el, "Organize here instead");
const confirmButton = (el: HTMLElement) => buttonSaying(el, "Organize here");

beforeEach(() => {
  FACTS = [READER];
  refreshed = 0;
  bridged = [];
  bridgeReply = () =>
    new Response(JSON.stringify({ outcome: "authorized", previousReason: "organized_elsewhere:local" }),
      { status: 200, headers: { "content-type": "application/json" } });
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async () => null,
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("an install that only READS a mailbox can ask to organize it", () => {
  it("names the holder and how long, and offers the one verb", async () => {
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text).toContain("owner@example.test");
    // WHO, AND SINCE WHEN — the holder's own machine name, not "another install".
    expect(text).toContain("Organized by zorin-9950");
    // WHAT THIS MACHINE IS AND IS NOT DOING. The row looks healthy because it IS healthy; what is
    // missing is that nothing here moves or screens anything, and only this sentence says so.
    expect(text).toContain("This computer reads the mailbox; it moves nothing and screens nothing.");
    expect(text).toContain("Reading only");
    expect(organizeButton(el), "a reader row offers nothing to press").not.toBeNull();
  });

  it("says the other side stands down rather than dies, before the press that does it", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    // The cost to the other install, stated BEFORE the confirm — it keeps its copy either way,
    // and it is NAMED, so the sentence is about a machine rather than about "another install".
    // A ceremony that only said "are you sure" would make somebody guess at both.
    expect(text).toContain("zorin-9950");
    expect(text).toContain("left alone either way");
    expect(bridged, "the first press wrote something instead of asking").toEqual([]);
  });

  it("confirming authorizes ONE becoming through the local door, and says when it happens", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });

    // THE ROUTE. The local door's own action, keyed on the mailbox id — not the account's
    // `POST /mailboxes/:id/organize`, which is a different ceremony with a different authority
    // and is not served on this door at all.
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.url).toBe("/local/organizer/takeover");
    expect(bridged[0]!.method).toBe("POST");
    expect(JSON.parse(bridged[0]!.body!)).toEqual({ mailboxId: "mbx-reader" });

    /* THE SENTENCE, AND IT NO LONGER SENDS ANYBODY TO RESTART THE APP. This comment said exactly
       that while the assertion under it pinned the restart sentence — the copy came back and the
       expectation was re-pinned to it, leaving the comment as a false claim about the product.
       Both agree now, and the fact they agree ON is `mayOrganize`: the gate re-reads
       `takeover_authorized_at` at the top of every run, so a press on a running install is spent
       on the next poll. Its own header calls that "a fact rather than a sentence". */
    const text = el.textContent ?? "";
    expect(text).toContain("takes over on its next pass");
    expect(text, "the retired restart instruction is back").not.toContain("Quit and reopen");

    // The row's own state moved, so the pane re-reads rather than keeping the banner on screen.
    expect(refreshed).toBe(1);
  });

  it("quotes the engine's OWN answer when nothing was written", async () => {
    // `already_organizing`, `removed` and `no_mailbox` are answers about the row rather than
    // refusals of the request — the route returns 200 for all four — and each says its own true
    // thing rather than a generic success.
    bridgeReply = () =>
      new Response(JSON.stringify({ outcome: "already_organizing", previousReason: null }),
        { status: 200, headers: { "content-type": "application/json" } });
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(el.textContent).toContain("This machine already organizes that mailbox");
    expect(el.textContent).not.toContain("takes over on its next pass");
  });

  /**
   * THE ANSWER IS A RECORDED REQUEST, NOT A PROMISE — and not a spinner either.
   *
   * `/local/organizer/takeover` writes a one-shot stamp; `runLeaseGate` reads the lease on its next
   * tick and MAY clear it without promoting anything (`engine.ts:1951-1955`) when the other holder
   * is still renewing. The sentence said the takeover would happen "within a minute" flat — the
   * caveat the retired copy carried was dropped with it — and rendered as `state="wait"`, so a
   * refusal spun for ever with nothing coming.
   */
  it("says the other install may keep the mailbox, and does not spin about it", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text).toContain("takes over on its next pass");
    expect(text, "the request was reported as a certainty the lease can refuse")
      .toContain("it keeps the mailbox and this one goes on reading");
    // A spinner claims something is in flight. Nothing is: the request is written and done.
    expect(el.querySelector(".set-verdict.wait"), "a recorded request was drawn as a pending one")
      .toBeNull();
  });

  /**
   * AND IT GOES WHEN IT ACTUALLY HAPPENED. `reclaimed` is only ever added to, so the block used to
   * render for the life of the pane — including after the poll confirmed the takeover worked and
   * the banner had gone, still saying the change was pending.
   */
  it("stops reporting the request once the role confirms it worked", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(el.textContent).toContain("takes over on its next pass");

    // The next poll: the gate promoted this install.
    FACTS = [{ ...READER, organizerRole: "organizer", organizedBy: null, organizerState: null }];
    await act(async () => { root!.render(await paneNode(null)); });
    expect(el.textContent, "a completed takeover still reported itself as pending")
      .not.toContain("takes over on its next pass");
    expect(el.textContent).not.toContain("Organized by");
  });

  /**
   * `organizedBy.since` IS NOT A HEARTBEAT. It is when the holder BECAME the organizer, and the
   * heartbeat is deliberately not persisted — so "last checked in 8 months ago" was reported about
   * an install that stopped this morning. The sentence claims only what is known.
   */
  it("does not date the silence it cannot date", async () => {
    FACTS = [{ ...READER, organizerState: "stopped" }];
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text).toContain("has stopped checking in");
    expect(text).toContain("new mail waits in the inbox");
    expect(text, "an age was invented from the date the holder became organizer")
      .not.toMatch(/last checked in|\bago\b/);
  });

  /**
   * `unknown` IS A LEGAL KIND, and it used to fall through to the Cloud sentence — so a row whose
   * wire says nothing about Cloud announced "ohmail Cloud" and named it as the holder.
   */
  it("does not call an unidentified holder ohmail Cloud", async () => {
    FACTS = [UNKNOWN_HOLDER];
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text, "an unidentified holder was announced as ohmail Cloud").not.toContain("ohmail Cloud");
    expect(text).toContain("another install");
    expect(text).toContain("it moves nothing and screens nothing");
    expect(organizeButton(el), "an unidentified holder is still a holder to claim from").not.toBeNull();
  });

  /**
   * A WINDOW NEWER THAN ITS ENGINE MUST NOT WITHDRAW THE ONLY EXIT. An engine predating the role
   * column reports a stand-down the old way and runs the old handler, which accepts exactly that
   * row — the two are one process. Without the legacy arm the pane offers nothing on precisely the
   * rows the old pane offered it on, which is the defect this surface was built to close.
   */
  it("still offers the claim on a stand-down from an engine that predates the role", async () => {
    FACTS = [LEGACY_STAND_DOWN];
    const el = await render(null);
    expect(organizeButton(el),
      "a window newer than its engine withdrew the only exit from a stand-down")
      .not.toBeNull();
  });

  /**
   * AND IT DESCRIBES THAT ROW AS FROZEN, NOT AS READING.
   *
   * The modern reader is connected and syncing, which is what every other banner sentence is
   * about. A pre-role engine's stand-down closed the IMAP handle and stopped the poll timer, so
   * the row is reading nothing — and its own state column says "Handed over to another install"
   * three lines to the right. The general fallback claimed the opposite of both.
   */
  it("does not tell a frozen legacy row that it is reading the mailbox", async () => {
    FACTS = [LEGACY_STAND_DOWN];
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text).toContain("stopped opening the mailbox");
    expect(text, "a frozen legacy row was described as a live reader")
      .not.toContain("This computer reads the mailbox");
    // It also has no holder columns at all, so there is no name to announce.
    expect(text).not.toContain("ohmail Cloud");
  });

  /**
   * THE ONE ROW THAT NEEDS THE RESTART IS THE ONE THAT COULD NOT SEE IT.
   *
   * The acknowledgement was gated on `organizerRole === "reader"`, and the mapper coerces a legacy
   * row's ABSENT role to `organizer` — so on exactly the rows the legacy arm exists for, pressing
   * the button made it disappear and put nothing in its place, with the takeover unapplied. A
   * pre-role engine spends the stamp at its next process assembly, not on a tick, so the restart
   * sentence this lane retired is the true one HERE and nowhere else.
   */
  /**
   * THE CEREMONY AND ITS ANSWER MUST AGREE. The confirmation step promised "on its next pass" for
   * every row, including the one whose engine has stopped its timer — so it contradicted the
   * acknowledgement it produced one press later, in the same ceremony.
   */
  it("promises the legacy engine's own mechanism at the confirmation, not the modern one", async () => {
    FACTS = [LEGACY_STAND_DOWN];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text).toContain("Quit and reopen ohmail and");
    // A legacy row has no holder columns, so its sentence names nobody.
    expect(text).toContain("unless the other install renews its claim first");
  });

  /**
   * THE TWO ENGINES DIFFER AGAIN, AND THIS DOCBLOCK NAMED ITS OWN FALSIFICATION CONDITION.
   *
   * It read "BOTH ENGINES NEED THE RELAUNCH ... If the engine ever re-reads that column per cycle,
   * the press becomes effective on the next pass and this expectation is the one that should
   * change first." That condition has been met: `mayOrganize` re-reads
   * `takeover_authorized_at` at the top of every gate (`apps/sidecar/src/engine.ts`, "THE STAMP
   * IS RE-READ EVERY RUN"), which it did precisely because a polling reader would otherwise
   * DESTROY the stamp — the poll asks with `takeover: "none"`, is refused, and the refusal arm
   * clears the row. So the modern reader is spent on the next poll and the restart sentence was
   * an instruction to do something neither needed nor helpful.
   *
   * The LEGACY row keeps it, and the case above is where that is pinned: it is `disabled`, so
   * `loadEnabledMailboxes` (`ne(status, 'disabled')`) keeps it off the roster and no gate ever
   * runs for it — the stamp is spent at the next process assembly, which is the relaunch.
   */
  it("tells a MODERN reader the next pass, which is what its gate actually does", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text).toContain("takes over on its next pass");
    expect(text, "the modern engine was sent to restart for a stamp its gate re-reads")
      .not.toContain("Quit and reopen");
    // A reader that loses the race keeps reading — that is what a reader IS, and it is the one
    // thing the legacy row cannot say.
    expect(text).toContain("this one goes on reading");
  });

  /**
   * THE CONFIRMATION SAYS WHAT THE LEASE CAN ACTUALLY GRANT, AND THAT DEPENDS ON WHO HOLDS IT.
   *
   * `decideLease` ranks cloud > local > unknown and this install is local, so an authorized
   * request DISPLACES a live local peer (rule 6) and is refused by a live cloud or unknown holder
   * (rules 5 and 2) whatever was authorized. One universal sentence is therefore wrong in one
   * direction or the other — and the copy here was wrong in BOTH in turn: it promised the takeover
   * flat, and then, correcting that, promised a running holder always keeps the mailbox.
   */
  it("promises the takeover against a live LOCAL peer, which the lease will displace", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text).toContain("on its next pass");
    expect(text, "the renewal race is the only thing that saves the peer, and it is stated")
      .toContain("unless zorin-9950 renews its claim first");
    expect(text, "a displaceable peer was described as unbeatable")
      .not.toContain("cannot take it yet");
  });

  it("does not promise a takeover a live CLOUD holder will refuse", async () => {
    FACTS = [CLOUD_HELD];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text, "the confirmation promised what rule 5 refuses even with authorization")
      .toContain("cannot take it yet");
    expect(text).toContain("Stop it organizing there first, then come back and ask again");
    expect(text, "a request the running loop can clear was described as kept")
      .not.toMatch(/kept until then|is kept/);
    expect(text).not.toContain("unless zorin-9950 renews its claim first");

    /* AND THE PRESS IS STILL THERE. Withholding it depended on `organizerState` moving off `held`
       once the other holder stopped — and if it does not, somebody who follows the sentence above
       returns to a pane whose only control has disappeared, which is the dead end this surface
       exists to close. Recording the request costs nothing and waits for the relaunch. */
    expect(confirmButton(el), "the only way back vanished for a holder that may since have stopped")
      .not.toBeNull();
    expect(buttonSaying(el, "Cancel")).not.toBeNull();
  });

  /**
   * AND ITS ANSWER DOES NOT BORROW THE OTHER BRANCH'S CONDITION. Rules 5 and 2 reject this holder
   * outright — the renewal race is the LOCAL peer's condition, and saying it here would tell
   * somebody the holder wins only if it renews, when it wins regardless.
   */
  it("answers a blocked request with the reason that actually applies", async () => {
    FACTS = [CLOUD_HELD];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text).toContain("keeps this mailbox for as long as it is still checking in");
    expect(text).toContain("whatever was asked for here");
    /* The reliable order. It used to end "and reopen ohmail", which was the running loop's
       staleness expressed as an instruction; the gate re-reads the stamp now, so asking again
       after the other organizer stops is the whole of it. */
    expect(text).toContain("then ask again");
    expect(text, "the retired restart instruction is back").not.toContain("reopen ohmail");
    expect(text, "a blocked request was answered with the local peer's renewal race")
      .not.toContain("renews its claim first");
  });

  /**
   * AN UNOBSERVED STATE IS NOT A STOPPED ONE. `organizerState` is `null` until this install's first
   * lease look, and stays null when that look fails — so a perfectly fresh cloud claim reports
   * `null`, and treating it as beatable promised a takeover rules 5 and 2 refuse.
   */
  it("does not read an unobserved organizer state as a beatable one", async () => {
    FACTS = [{ ...CLOUD_HELD, id: "mbx-cloud-unlooked", organizerState: null }];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    expect(el.textContent, "a state nobody has looked at was treated as stopped")
      .toContain("cannot take it yet");
  });

  it("…and promises it again once that cloud holder has stopped checking in", async () => {
    FACTS = [CLOUD_STOPPED];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text, "a quiet holder is beatable and the confirmation withheld that")
      .toContain("on its next pass");
    expect(text).not.toContain("cannot take it yet");
  });

  /**
   * AND NEITHER CONFIRMATION MAY PROMISE THE MAILBOX OUTRIGHT.
   *
   * `authorize OrganizerTakeover` says it in its own docblock: *"this grants permission to ASK,
   * never permission to WIN"* — an organizer still renewing keeps the mailbox regardless of what
   * was authorized. Both sentences said the takeover happens, flat, and the acknowledgement one
   * press later carried the caveat, so the ceremony contradicted itself in both vocabularies. The
   * review named only the legacy one, because that is the sentence the diff had touched.
   */
  it.each([
    ["a modern reader", null],
    ["a legacy stand-down", "legacy"],
  ])("%s is told the other install keeps its copy either way", async (_what, kind) => {
    if (kind === "legacy") FACTS = [LEGACY_STAND_DOWN];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    // The cost to the other side is the one thing true of every branch: it is not killed, and its
    // copy of the mail survives whichever way the lease decides.
    expect(text).toContain("left alone either way");
    expect(text).toContain("does not take it");
    expect(text, "a confirmation stated an outcome with no condition on it at all")
      .toMatch(/unless .* renews its claim first/);
  });

  it("tells a legacy install to relaunch, which is the mechanism on that engine", async () => {
    FACTS = [LEGACY_STAND_DOWN];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    const text = el.textContent ?? "";
    expect(text, "the row the legacy arm exists for got no acknowledgement at all")
      .toContain("Quit and reopen ohmail to organize this mailbox");
    // A legacy stand-down closed its handle and stopped its timer, so it reads NOTHING while it
    // waits. The modern reader's tail would be false here.
    expect(text).toContain("this one stays stood down");
    expect(text, "a stood-down legacy install was told it goes on reading")
      .not.toContain("goes on reading");
  });


  /**
   * AND THE RETRY IS STILL THERE AFTERWARDS, because the answer tells somebody to use it.
   *
   * `reclaimed` records that a request was made and is never cleared — correct for a request that
   * can succeed, since the row's own role is what ends it. A blocked request can never succeed, so
   * its entry hid the button for the life of the pane while the sentence beside it said "stop it
   * organizing there, then ask again". That is the dead end this screen exists to close, reached
   * through the one branch whose entire purpose is to send somebody back.
   */
  it("keeps the retry reachable after a blocked request, which its own answer tells you to use", async () => {
    FACTS = [CLOUD_HELD];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(el.textContent).toContain("then ask again");
    expect(organizeButton(el),
      "the answer said to ask again and the button it meant was gone")
      .not.toBeNull();
  });

  /**
   * THE TRANSITION THE INSTRUCTION SENDS SOMEBODY TO MAKE — and the case that was missing.
   *
   * The blocked answer says "stop it organizing there, then ask again". Doing that turns the row's
   * `organizerState` from `held` to `stopped`, at which point the request could finally succeed —
   * and a guard written against the row's CURRENT blocked-ness took the button away at exactly
   * that moment, because the spent-request marker was still set. The earlier case could not see
   * it: it asserted the button on the blocked row and never re-rendered with the stopped one.
   */
  it("keeps the retry across the very transition its answer tells you to make", async () => {
    FACTS = [CLOUD_HELD];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(organizeButton(el), "the retry was gone while the holder was still there").not.toBeNull();

    // The user goes and stops it organizing there; the reader cycle refreshes the same row.
    FACTS = [{ ...CLOUD_HELD, organizerState: "stopped" }];
    await act(async () => { root!.render(await paneNode(null)); });
    expect(organizeButton(el),
      "the button vanished at the moment the retry would have worked, which is what the answer " +
        "sent somebody away to bring about")
      .not.toBeNull();
  });

  /**
   * AND THE REVERSE TRANSITION, which the previous fix regressed.
   *
   * A holder that was quiet when the request went in can resume before this install is promoted.
   * The lease then refuses the authorization and the running loop clears it — so the request no
   * longer exists, while the marker recorded at press time still said "beatable" and went on
   * suppressing the button for the life of the pane.
   */
  it("keeps the retry when a once-beatable request becomes blocked", async () => {
    FACTS = [CLOUD_STOPPED];
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(organizeButton(el), "a request that can still succeed should spend its button").toBeNull();

    // The holder wakes up again before this install is promoted.
    FACTS = [{ ...CLOUD_STOPPED, organizerState: "held" }];
    await act(async () => { root!.render(await paneNode(null)); });
    expect(organizeButton(el),
      "the lease refused the request and cleared it, and the pane kept suppressing the retry")
      .not.toBeNull();
  });

  it("…and a request that CAN succeed still spends its button", async () => {
    // The negative control: a beatable holder's request is one-shot, so the button goes and the
    // acknowledgement stands in its place until the role confirms it.
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(organizeButton(el), "a spent one-shot request still offered its button").toBeNull();
  });

  it("is NOT offered on a TOMBSTONE — the handler refuses that row and so does the pane", async () => {
    FACTS = [REMOVED];
    const el = await render(null);
    expect(el.textContent).toContain("Disconnected");
    expect(organizeButton(el),
      "offering a claim on a removal resurrects a mailbox somebody took off this machine, and " +
        "`organizeHere` declines it anyway")
      .toBeNull();
  });

  it("is NOT offered on a mailbox this machine already organizes", async () => {
    FACTS = [ORGANIZER];
    const el = await render(null);
    expect(el.textContent).not.toContain("Organized by");
    expect(organizeButton(el), "a claim banner was drawn over a mailbox this machine organizes")
      .toBeNull();
    expect(buttonSaying(el, "Sync now")).not.toBeNull();
  });

  it("is NOT offered on the HOSTED door — the claim there is the account's ceremony", async () => {
    const el = await render("cloud");
    expect(el.textContent).toContain("owner@example.test");
    expect(organizeButton(el),
      "the local takeover route is not served on the hosted door; a button for it would 404")
      .toBeNull();
  });

  /**
   * AN ENGINE THAT PREDATES THE COLUMN IS AN ORGANIZER, NOT A READER.
   *
   * The desktop updates on its own schedule, so a window newer than its engine is an ordinary
   * state rather than an error. The absent field has to read as `organizer`: the other default
   * would put a claim banner over every mailbox on every older install.
   */
  it("treats an absent role as this install organizing, never as reading", async () => {
    const { organizerRole: _role, organizedBy: _by, organizerState: _st, ...older } = READER;
    FACTS = [older as MailboxFacts];
    const el = await render(null);
    expect(el.textContent).not.toContain("Organized by");
    expect(organizeButton(el)).toBeNull();
  });

  it("a holder that stopped renewing gets its own sentence, not the calm one", async () => {
    FACTS = [{ ...READER, organizerState: "stopped" }];
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text).toContain("has stopped checking in");
    expect(text).toContain("new mail waits in the inbox");
    expect(text, "a stopped holder was described with the steady-state sentence")
      .not.toContain("it moves nothing and screens nothing");
    expect(organizeButton(el), "the one state that most needs the claim did not offer it").not.toBeNull();
  });
});

/**
 * THE WIRE → FACTS MAPPER, driven directly.
 *
 * The cases above inject `MailboxFacts` through the mocked provider, so they exercise the PANE and
 * never reach `readMailboxFactsVia` — which is where the "absent reads as organizer" default
 * lives. Inverting that default left every case above green, which is how this block came to
 * exist: the component's own test could not see the mapper at all.
 *
 * The default matters more than it looks. A desktop updates on its own schedule, so a window newer
 * than its engine is ordinary, and every install predating the column sends no role. Reading that
 * as `reader` would put a claim banner over every mailbox on every one of them.
 */
describe("the mailbox wire is mapped with the safe default for an engine that predates the role", () => {
  const answer = (row: Record<string, unknown>) =>
    async (url: string): Promise<Response> => {
      expect(url).toBe("/mailboxes");
      return new Response(JSON.stringify({ items: [row] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
  const base = { id: "m1", address: "a@example.test", status: "connected", lastSyncAt: null };

  it("an absent role is an ORGANIZER, never a reader", async () => {
    const { readMailboxFactsVia } = await import("../src/DesktopMailboxes.js");
    const [row] = await readMailboxFactsVia(answer(base) as never);
    expect(row!.organizerRole, "an engine that predates the column demoted this install").toBe("organizer");
    expect(row!.organizedBy).toBeNull();
    expect(row!.organizerState).toBeNull();
  });

  it("a role the wire does send is carried through, holder and all", async () => {
    const { readMailboxFactsVia } = await import("../src/DesktopMailboxes.js");
    const [row] = await readMailboxFactsVia(
      answer({
        ...base,
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "zorin-9950", since: "2026-08-28T09:00:00.000Z" },
        organizerState: "held",
      }) as never,
    );
    expect(row!.organizerRole).toBe("reader");
    expect(row!.organizedBy).toEqual({ kind: "local", name: "zorin-9950", since: "2026-08-28T09:00:00.000Z" });
    expect(row!.organizerState).toBe("held");
  });

  it("a role the wire sends that this build does not know is an ORGANIZER too", async () => {
    // The same argument in the other direction: a value from a NEWER engine must not be guessed
    // into the demoting branch.
    const { readMailboxFactsVia } = await import("../src/DesktopMailboxes.js");
    const [row] = await readMailboxFactsVia(answer({ ...base, organizerRole: "custodian" }) as never);
    expect(row!.organizerRole).toBe("organizer");
  });
});
