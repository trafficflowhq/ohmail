import { afterEach, describe, expect, it } from "vitest";
import {
  forgetOrganizerSessionForTests, holdStandaloneDoor, onOrganizerState, pokeOrganizerState, pressOrganizeHere,
  standaloneHere,
} from "../src/engine/organizer-session";
import type { ClaimHereOutcome, StandaloneEngine } from "../src/engine/standalone-door";
import { organizerStripOf } from "../src/ui/organizer-strip";
import {
  claimChipLabel, claimHere, claimNoteLine, mayStartHere, pressSaidLine, pressSaidOf, readingAtConnectLine,
  readingAtConnectNow,
} from "../src/ui/standalone-form";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

/**
 * THE PHONE'S CARD FOLLOWS THE ENGINE'S LAST LOOK, AND SAYS WHY A STOP WAITS. A holder that let
 * go read `Organized by another install` until the claim watch ticked, because the card built the
 * holder from the remembered stand-down reason alone; and a stop waiting on a copy of this phone's
 * claim said nothing of it. The engine now carries the look's occupancy and the refusal, and the
 * card asks `holderIsLive` of them. To watch it fail: drop the `holderIsLive` arm of `claimHere`.
 */

type Organizer = ReturnType<StandaloneEngine["runtimes"]>["organizer"][string];

function door(organizer: Organizer, claimed: ClaimHereOutcome = "refused"): StandaloneEngine {
  const no = async (): Promise<never> => { throw new Error("not driven by this case"); };
  return {
    accountId: "engine-account", address: "held@example.test", sessionToken: "engine-launch-token",
    handle: no, stop: async () => undefined, log: () => undefined,
    handBack: async () => [{ mailboxId: "m1", released: 1 }], leave: () => undefined,
    forgetStoredLogin: async () => true, serverSettings: async () => null,
    resume: async () => [{ mailboxId: "m1", served: 1 }],
    claimHere: async () => claimed, heldElsewhere: async () => null, stopOrganizing: no,
    runtimes: () => ({
      organizer: { m1: organizer },
      connection: { m1: { reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished" } },
    }),
  };
}

const STOOD_DOWN = {
  organizing: false, heldBy: null, reason: "organized_elsewhere:local", releaseRequestedAt: null, claimed: false,
};

describe("the card reads the look, not the remembered stand-down", () => {
  afterEach(() => { forgetOrganizerSessionForTests(); });

  it.each([
    ["none", "the look found no claim", { k: "free", starting: false }],
    ["stopped", "the holder's claim lapsed", { k: "free", starting: false }],
    ["held", "the holder still renews", { k: "theirsUnnamed", kind: "local" }],
    [null, "a relaunch has not looked yet", { k: "theirsUnnamed", kind: "local" }],
  ] as const)("holderState %s (%s)", (holderState, _why, want) => {
    expect(holdStandaloneDoor(door({ ...STOOD_DOWN, holderState }))).toBe(true);
    const here = standaloneHere()!;
    expect(here.heldBy, "the projection dropped the look").toEqual({
      name: "", standDownReason: "organized_elsewhere:local", holderState,
    });
    expect(claimHere(here)).toEqual(want);
  });

  it("a press in flight over a holder that let go reads Starting", () => {
    expect(holdStandaloneDoor(door({ ...STOOD_DOWN, holderState: "none" }))).toBe(true);
    expect(claimHere(standaloneHere()!, "starting")).toEqual({ k: "free", starting: true });
  });

  it("an engine that predates the field keeps the stand-down's sentence", () => {
    expect(holdStandaloneDoor(door({ ...STOOD_DOWN }))).toBe(true);
    expect(claimHere(standaloneHere()!)).toEqual({ k: "theirsUnnamed", kind: "local" });
  });
});

describe("a stop waiting on a copy of this phone's claim says so", () => {
  afterEach(() => { forgetOrganizerSessionForTests(); });
  const WAITING = {
    organizing: false, heldBy: null, reason: null, releaseRequestedAt: "2026-09-29T08:00:00.000Z", claimed: false,
  };

  it("the engine's refusal reaches the card and its sentence, in both decks", () => {
    expect(holdStandaloneDoor(door({ ...WAITING, releaseRefusal: "sibling_lapse", holderState: null }))).toBe(true);
    const here = standaloneHere()!;
    expect(here.releaseRefusal).toBe("sibling_lapse");
    const claim = claimHere(here);
    expect(claim).toEqual({ k: "ours", stopping: false, releasePending: true, siblingLapse: true });
    expect(claimNoteLine(claim, "android")).toBe(EN.phoneStateStopSiblingLapse);
    expect(DE.phoneStateStopSiblingLapse).not.toBe(EN.phoneStateStopSiblingLapse);
  });

  it("CONTROL: a stop still being carried out keeps its own sentence", () => {
    expect(holdStandaloneDoor(door({ ...WAITING, releaseRefusal: null, holderState: null }))).toBe(true);
    const claim = claimHere(standaloneHere()!);
    expect(claim).toEqual({ k: "ours", stopping: false, releasePending: true });
    expect(claimNoteLine(claim, "android")).toBe(EN.phoneStateStopPendingWhy);
  });
});

/**
 * A NEVER-CONSENTED READER'S CARD FOLLOWS THE LOOK (RULING-026 lane D). Its look
 * writes `reason: null` by design (nobody stood anything down), and the card found its holder by
 * the reason alone: "Nothing organizes this mailbox" with Start beside it for 20.9 min while a
 * laptop organized, until a press was refused. The look's own word names the holder now.
 * TO WATCH IT FAIL: in `organizer-session.ts#standaloneHere`, find `stood` by
 * `state.reason !== null` alone — the first case reddens; or drop `holderState` from
 * `pokeOrganizerState`'s fingerprint — the flip case reddens.
 */
describe("a never-consented reader's card follows the look", () => {
  afterEach(() => { forgetOrganizerSessionForTests(); });
  const NAME = "ohmail on omarchy";
  const PRE_CONSENT = { organizing: false, heldBy: NAME, reason: null, releaseRequestedAt: null, claimed: false };

  it("a look reading `held` names the holder, and Start is not offered", () => {
    expect(holdStandaloneDoor(door({ ...PRE_CONSENT, holderState: "held" }))).toBe(true);
    const here = standaloneHere()!;
    expect(here.heldBy, "the look's holder never reached the card").toEqual({
      name: NAME, standDownReason: null, holderState: "held",
    });
    const claim = claimHere(here);
    expect(claim).toEqual({ k: "theirs", name: NAME, kind: "unknown" });
    expect(claimChipLabel(claim)).toBe(EN.phoneStateReader(NAME));
    expect(claimNoteLine(claim, "android")).toBe(EN.phoneStateReaderWhy(NAME));
    expect(mayStartHere(claim), "Start was offered over a mailbox a laptop organizes").toBe(false);
    expect(organizerStripOf(claim, { stoppedHere: true, late: false, os: "android" })?.start).toBe(false);
  });

  it.each([
    ["none", "the look found no claim"],
    ["stopped", "the holder's claim lapsed"],
    [null, "no look yet"],
  ] as const)("CONTROL: holderState %s (%s) is nothing organizing, and Start is offered", (holderState, _why) => {
    expect(holdStandaloneDoor(door({ ...PRE_CONSENT, holderState }))).toBe(true);
    const claim = claimHere(standaloneHere()!);
    expect(claim).toEqual({ k: "free", starting: false });
    expect(mayStartHere(claim)).toBe(true);
  });

  it("a hand-back and a re-claim move the card both ways with no press, and each move is told", () => {
    const state: Organizer = { ...PRE_CONSENT, holderState: "held" };
    expect(holdStandaloneDoor(door(state))).toBe(true);
    let told = 0;
    const off = onOrganizerState(() => { told += 1; });
    try {
      pokeOrganizerState();
      const settled = told;
      pokeOrganizerState();
      expect(told, "an unchanged look re-rendered the panel").toBe(settled);
      /* The desktop hands back: the look reads the claim lapsed under the SAME name. */
      state.holderState = "stopped";
      pokeOrganizerState();
      expect(told, "the hand-back was not told to an open panel").toBe(settled + 1);
      expect(claimHere(standaloneHere()!)).toEqual({ k: "free", starting: false });
      /* The desktop organizes again. */
      state.holderState = "held";
      pokeOrganizerState();
      expect(told, "the re-claim was not told to an open panel").toBe(settled + 2);
      expect(claimHere(standaloneHere()!)).toEqual({ k: "theirs", name: NAME, kind: "unknown" });
    } finally {
      off();
    }
  });
});

/**
 * A START REFUSED WITH THE CONSENT KEPT SAYS BOTH FACTS (RULING-026 Q3). The door records a
 * person's consent on a refused press, and the press said nothing of it. TO WATCH IT FAIL: map
 * `held_consented` to `null` in `pressSaidOf`.
 */
describe("a Start refused with the consent kept says both facts", () => {
  afterEach(() => { forgetOrganizerSessionForTests(); });
  const NAME = "ohmail on omarchy";
  const HELD = { organizing: false, heldBy: NAME, reason: null, releaseRequestedAt: null, claimed: false, holderState: "held" as const };

  it("the press carries the door's word to the line beside the verb", async () => {
    expect(holdStandaloneDoor(door({ ...HELD }, "held_consented"))).toBe(true);
    const outcome = await pressOrganizeHere("start");
    expect(outcome).toBe("held_consented");
    const claim = claimHere(standaloneHere()!);
    expect(pressSaidLine(pressSaidOf(outcome), claim)).toBe(EN.settingsStartHeldConsented(NAME));
    expect(pressSaidLine(pressSaidOf(outcome), { k: "theirsUnnamed", kind: "local" }))
      .toBe(EN.settingsStartHeldConsentedUnknown);
  });

  it("over a mailbox this phone organized, the refusal says the phone takes it back by itself", async () => {
    expect(holdStandaloneDoor(door({ ...HELD }, "held_returns"))).toBe(true);
    const outcome = await pressOrganizeHere("start");
    expect(outcome).toBe("held_returns");
    expect(pressSaidLine(pressSaidOf(outcome), claimHere(standaloneHere()!))).toBe(EN.settingsStartHeldReturns(NAME));
    expect(DE.settingsStartHeldReturns(NAME)).not.toBe(EN.settingsStartHeldReturns(NAME));
  });

  it("CONTROL: a plain `held` owes no sentence, and the kept one ends with the holder", () => {
    expect(pressSaidOf("held")).toBeNull();
    expect(pressSaidLine("startHeldConsented", { k: "free", starting: false })).toBeNull();
    expect(pressSaidLine("startHeldConsented", { k: "ours", stopping: false, releasePending: false })).toBeNull();
  });

  it("the connect notice says it too, and keeps saying it under the live holder", () => {
    expect(readingAtConnectLine({ name: NAME, consentRecorded: true })).toBe(EN.readingAtConnectKept(NAME));
    expect(readingAtConnectLine({ name: "", consentRecorded: true })).toBe(EN.readingAtConnectKeptUnknown);
    expect(readingAtConnectLine({ name: NAME })).toBe(EN.readingAtConnect(NAME));
    expect(readingAtConnectNow({ name: "", consentRecorded: true }, { k: "theirs", name: NAME, kind: "local" }))
      .toEqual({ name: NAME, consentRecorded: true });
    expect(DE.settingsStartHeldConsented(NAME)).not.toBe(EN.settingsStartHeldConsented(NAME));
    expect(DE.readingAtConnectKept(NAME)).not.toBe(EN.readingAtConnectKept(NAME));
  });

  /* A PRESS THE DOOR KEEPS WAITING: the notice says when the phone takes the mailbox by itself, and
     goes once it does. TO WATCH IT FAIL: drop `joinWaits` from `readingAtConnectNow`'s kept facts. */
  it("a waiting press says the phone takes over a holder already gone, and the notice ends once it organizes", () => {
    const said = { name: "", consentRecorded: true, joinWaits: true };
    const now = readingAtConnectNow(said, { k: "theirs", name: NAME, kind: "mobile" });
    expect(now).toEqual({ name: NAME, consentRecorded: true, joinWaits: true });
    expect(readingAtConnectLine(now!)).toBe(EN.readingAtConnectJoinWaits(NAME));
    expect(readingAtConnectLine({ ...said, name: " " })).toBe(EN.readingAtConnectJoinWaitsUnknown);
    expect(EN.readingAtConnectJoinWaits(NAME)).not.toBe(EN.readingAtConnectKept(NAME));
    expect(EN.readingAtConnectJoinWaits(NAME)).toContain(`once ${NAME} lets go, this phone offers the mailbox`);
    expect(DE.readingAtConnectJoinWaits(NAME)).not.toBe(EN.readingAtConnectJoinWaits(NAME));
    expect(readingAtConnectNow(said, { k: "ours", stopping: false, releasePending: false }), "the notice outlived the take-over")
      .toBeNull();
  });
});
