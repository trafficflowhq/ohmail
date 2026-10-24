/**
 * THE PHONE SAYS THE DESKTOP ROW'S SENTENCE FOR A `_meta` ITS GATE CANNOT READ (PHONE-START-HERE-
 * META-FOLDER-FULL, with REVIEW-02514 LOW 2). The standalone strip read only `organizing`, `reason`
 * and `heldBy`, so a refused gate rendered "Nothing organizes this mailbox" with Start. The engine's
 * `unreadableReason` now decides a `blocked` claim — the desktop sentence, no Start — and a press
 * refused under the same code says the same sentence.
 */
import { afterEach, describe, expect, it } from "vitest";

import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import {
  claimHereStandalone, forgetOrganizerSessionForTests, holdStandaloneDoor, pressOrganizeHere, standaloneHere,
} from "../src/engine/organizer-session";
import type { ClaimHereOutcome, StandaloneEngine } from "../src/engine/standalone-door";
import { organizerStripOf } from "../src/ui/organizer-strip";
import {
  claimChipLabel, claimHere, mayStartHere, mayStopHere, pressSaidLine, pressSaidOf,
} from "../src/ui/standalone-form";

afterEach(() => { forgetOrganizerSessionForTests(); });

const facts = { stoppedHere: true, late: false, os: "android" } as const;
const here = (over: Partial<Parameters<typeof claimHere>[0]> = {}) => ({
  organizing: false, releaseRequestedAt: null, heldBy: null, ...over,
});

function door(
  unreadableReason: string | null, answer: ClaimHereOutcome = "refused", organizing = false,
  profileBlocked?: { code: string | null; confirmed: boolean } | null,
  releaseRequestedAt: string | null = null,
): StandaloneEngine {
  const no = async (): Promise<never> => { throw new Error("not driven by this case"); };
  return {
    accountId: "engine-account", address: "held@example.test", sessionToken: "t", handle: no,
    stop: async () => undefined, log: () => undefined,
    handBack: async () => [{ mailboxId: "m1", released: 1 }], leave: () => undefined,
    forgetStoredLogin: async () => true, serverSettings: async () => null,
    resume: async () => [{ mailboxId: "m1", served: 1 }],
    claimHere: async () => answer, heldElsewhere: async () => null, stopOrganizing: no,
    runtimes: () => ({
      organizer: { m1: { organizing, heldBy: null, reason: null, releaseRequestedAt, claimed: true, unreadableReason } },
      connection: { m1: {
        reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished",
        ...(profileBlocked !== undefined ? { profileBlocked } : {}),
      } },
    }),
  };
}

describe("the strip over a gate refused by name", () => {
  it.each([
    ["meta_folder_full", EN.phoneStateMetaFolderFull],
    ["meta_undeletable", EN.phoneStateMetaUndeletable],
    ["clock_off", EN.phoneStateClockOff],
  ] as const)("%s: the desktop sentence, and no Start", (reason, sentence) => {
    expect(holdStandaloneDoor(door(reason))).toBe(true);
    const read = standaloneHere();
    expect(read?.metaBlocked, "the engine's reason never reached the phone's state").toBe(reason);
    const claim = claimHere(read!, "idle", false);
    expect(claim, "a refused gate read as a free mailbox").toEqual({ k: "blocked", reason, holding: false });
    expect(claimChipLabel(claim)).toBe(sentence);
    expect(mayStartHere(claim), "Start was offered over a gate that refuses it").toBe(false);
    expect(organizerStripOf(claim, facts)).toEqual({ label: sentence, note: null, late: null, start: false });
  });

  it("CONTROL: an ordinary unreadable lease is still the free arm", () => {
    expect(holdStandaloneDoor(door("lease_unreadable"))).toBe(true);
    expect(standaloneHere()?.metaBlocked).toBeNull();
    expect(claimHere(standaloneHere()!, "idle", false)).toEqual({ k: "free", starting: false });
  });

  it("a stop the person is carrying out outranks the reason", () => {
    expect(claimHere(here({ organizing: true, metaBlocked: "meta_folder_full" }), "stopping", false).k).toBe("ours");
    expect(claimHere(here({ organizing: false, metaBlocked: "meta_folder_full", releaseRequestedAt: "2026-10-05T10:00:00.000Z" }),
      "idle", false).k).toBe("ours");
  });

  it("the German strip says the German desktop sentence", () => {
    expect(DE.phoneStateMetaFolderFull).toContain("ohmail/_meta");
    expect(DE.phoneStateMetaUndeletable).toContain("ohmail/_meta");
    expect(DE.phoneStateClockOff).toContain("Uhr dieses Handys");
  });
});

describe("a Start refused under that code says the same sentence", () => {
  it.each([
    ["meta_folder_full", "startMetaFolderFull", EN.phoneStateMetaFolderFull],
    ["meta_undeletable", "startMetaUndeletable", EN.phoneStateMetaUndeletable],
    ["clock_off", "startClockOff", EN.phoneStateClockOff],
  ] as const)("%s", async (code, said, sentence) => {
    expect(holdStandaloneDoor(door(null, code))).toBe(true);
    await expect(claimHereStandalone()).resolves.toBe(code);
    await expect(pressOrganizeHere("start"), "the press folded the named refusal into a silent no-op").resolves.toBe(code);
    expect(pressSaidOf(code)).toBe(said);
    expect(pressSaidLine(pressSaidOf(code), { k: "free", starting: false }), "the press said nothing a person can act on")
      .toBe(sentence);
    expect(pressSaidLine(pressSaidOf(code), { k: "blocked", reason: code, holding: false }), "the sentence was said twice").toBeNull();
  });

  it("CONTROL: the other refusals keep their own sentences", () => {
    expect(pressSaidLine(pressSaidOf("unreadable"), { k: "free", starting: false })).toBe(EN.settingsStartHereUnreadable);
    expect(pressSaidLine(pressSaidOf("refused"), { k: "free", starting: false })).toBe(EN.settingsStartHereFailed);
    expect(pressSaidOf("started")).toBeNull();
  });
});

/* HIGH-1: the likeliest route — a phone ALREADY ORGANIZING whose poll gate
   starts refusing. The engine keeps `organizing: true` (Stop reads it) beside the reason, measured
   after three refused polls (`apps/sidecar/test/poll-arm-meta-refused.test.ts`); the phone shows the
   sentence, keeps Stop, and reads Organizing again at the first healthy pass. */
describe("an organizing phone whose poll gate refuses", () => {
  it.each([
    ["meta_folder_full", EN.phoneStateMetaFolderFull],
    ["meta_undeletable", EN.phoneStateMetaUndeletable],
    ["clock_off", EN.phoneStateClockOff],
  ] as const)("%s: the sentence over Organizing, and Stop stays", (reason, sentence) => {
    expect(holdStandaloneDoor(door(reason, "refused", true))).toBe(true);
    const claim = claimHere(standaloneHere()!, "idle", false);
    expect(claim, "a refused gate read as Organizing").toEqual({ k: "blocked", reason, holding: true });
    expect(claimChipLabel(claim)).toBe(sentence);
    expect(mayStopHere(claim), "the holder lost its Stop").toBe(true);
    expect(mayStartHere(claim)).toBe(false);
    expect(organizerStripOf(claim, { ...facts, stoppedHere: false })?.label).toBe(sentence);
  });

  it("the first healthy pass reads Organizing again", () => {
    expect(holdStandaloneDoor(door(null, "refused", true))).toBe(true);
    const claim = claimHere(standaloneHere()!, "idle", false);
    expect(claim.k).toBe("ours");
    expect(claimChipLabel(claim)).toBe(EN.phoneStateOrganizing);
    expect(organizerStripOf(claim, { ...facts, stoppedHere: false }), "Organizing draws no strip").toBeNull();
  });
});

/* PHONE-HIDES-PROFILE-BLOCKED: the engine raises `profileBlocked` once profile writes keep failing
   (the phone's append threw for three weeks with no code); the phone said only Organizing. */
describe("an organizing phone whose settings document cannot be kept", () => {
  it.each([
    ["profile_gap_too_deep", EN.phoneStateSettingsUnsyncedCode("profile_gap_too_deep")],
    [null, EN.phoneStateSettingsUnsynced],
  ] as const)("code %s: the state carries it and the chip and strip say it, Stop stays", (code, said) => {
    expect(holdStandaloneDoor(door(null, "refused", true, { code, confirmed: true }))).toBe(true);
    const read = standaloneHere();
    expect(read?.profileBlocked, "the engine's block never reached the phone's state").toEqual({ code });
    const claim = claimHere(read!, "idle", false);
    expect(claim.k).toBe("ours");
    expect(claimChipLabel(claim), "the chip said Organizing over failing profile writes")
      .toBe(said);
    expect(mayStopHere(claim)).toBe(true);
    expect(organizerStripOf(claim, { ...facts, stoppedHere: false }))
      .toEqual({ label: said, note: null, late: null, start: false });
  });

  it("the sentence names the code where there is one, and claims no read", () => {
    expect(EN.phoneStateSettingsUnsyncedCode("profile_gap_too_deep")).toContain("(profile_gap_too_deep)");
    expect(DE.phoneStateSettingsUnsyncedCode("profile_gap_too_deep")).toContain("(profile_gap_too_deep)");
    expect(EN.phoneStateSettingsUnsynced).not.toMatch(/can't read/);
  });

  it("a stop not yet honoured keeps its own chip", () => {
    expect(holdStandaloneDoor(door(null, "refused", true, { code: null, confirmed: true }, "2026-10-25T08:00:00.000Z")))
      .toBe(true);
    expect(claimChipLabel(claimHere(standaloneHere()!, "idle", false))).toBe(EN.phoneStateStopPending);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["unconfirmed", { code: "profile_gap_too_deep", confirmed: false }],
  ] as const)("CONTROL: %s reads Organizing and draws no strip", (_, block) => {
    expect(holdStandaloneDoor(door(null, "refused", true, block))).toBe(true);
    expect(standaloneHere()?.profileBlocked).toBeNull();
    const claim = claimHere(standaloneHere()!, "idle", false);
    expect(claimChipLabel(claim)).toBe(EN.phoneStateOrganizing);
    expect(organizerStripOf(claim, { ...facts, stoppedHere: false })).toBeNull();
  });
});
