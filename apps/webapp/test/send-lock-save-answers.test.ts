/** @vitest-environment jsdom */
/**
 * A SEND LANE THAT WAS NOT WRITTEN DOWN SAYS SO.
 *
 * `send-lock.ts#save` swallowed its own refusal — the comment said the lock was "as durable as the
 * tab, exactly as before" — so in a private window or against a full quota the record naming which
 * Idempotency-Key a send went out under was never stored, while every reader above it went on
 * speaking as though it had been. The press is still admitted (a browser with no jar must not lose
 * the ability to send mail), so what was missing was not a refusal but a SENTENCE: the shell's
 * once-per-session notice that this browser is not keeping decisions between reloads.
 *
 * Both arms of `save` are driven here, because they are two different jar calls: the mint writes
 * (`claimSendLock` → `durableSet`) and the last release removes (`releaseSendLock` on the only row
 * → `durableRemove`). Against the swallowing form every "lost" expectation below reads "stored"
 * and no event arrives, which is the red-before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DURABILITY_LOST_EVENT,
  durabilityLost,
  resetDurabilityForTest,
  type DurabilityLostDetail,
} from "@ohmail/app-logic/storage/durable";
import {
  SEND_LOCK_FORMAT,
  claimSendLock,
  releaseSendLock,
  sendLocksKey,
  type SendLock,
} from "../app/shell/send-lock";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

const OWNER = "acct-1";

const lockOf = (over: Partial<SendLock> = {}): SendLock => ({
  v: SEND_LOCK_FORMAT,
  lane: "compose",
  key: "idem-key-1",
  at: Date.now(),
  draftId: null,
  fp: "fp-1",
  ...over,
});

/** Which stores announced a lost write during one cell. */
let announced: string[] = [];
const collect = (e: Event): void => {
  announced.push((e as CustomEvent<DurabilityLostDetail>).detail.store);
};

beforeEach(() => {
  resetDurabilityForTest();
  announced = [];
  window.localStorage.clear();
  window.addEventListener(DURABILITY_LOST_EVENT, collect);
});

afterEach(() => {
  window.removeEventListener(DURABILITY_LOST_EVENT, collect);
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the send lock answers for a write the jar refused", () => {
  /** THE POSITIVE CONTROL: an ordinary jar stores the claim and says nothing. */
  it("a working jar stores the lane and raises no notice", () => {
    claimSendLock(lockOf(), NONE_OWED, OWNER);

    expect(window.localStorage.getItem(sendLocksKey(OWNER)), "the claim was not stored").toContain("idem-key-1");
    expect(announced, "a successful write must not raise the notice").toEqual([]);
    expect(durabilityLost()).toBe(false);
  });

  it("a REFUSED write announces the lost lane instead of swallowing it", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      claimSendLock(lockOf(), NONE_OWED, OWNER);
    } finally {
      setItem.mockRestore();
    }

    expect(announced, "the refused write was swallowed — nothing reached the shell").toEqual(["send.locks"]);
    // The notice is what the reader actually sees, and it is on until dismissed.
    expect(durabilityLost(), "the shell has nothing to draw").toBe(true);
    // …and the claim genuinely is not there, which is the fact the sentence is about.
    expect(window.localStorage.getItem(sendLocksKey(OWNER))).toBeNull();
  });

  it("a REFUSED removal of the last lane announces it too", () => {
    claimSendLock(lockOf(), NONE_OWED, OWNER);
    expect(announced, "setup must not itself announce").toEqual([]);

    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      // The only row, so `save` takes its remove arm.
      releaseSendLock("compose", "fp-1", NONE_OWED, OWNER);
    } finally {
      removeItem.mockRestore();
    }

    expect(announced, "a jar that will not drop a spent lane is the same fact about the browser")
      .toEqual(["send.locks"]);
    expect(durabilityLost()).toBe(true);
  });

  /**
   * ONE NOTICE PER SESSION, MANY EVENTS. Each caller has its own degradation to run, so the event
   * fires every time; the strip is a latch. Two refused claims must not stack two notices.
   */
  it("two refused writes raise two events and one notice", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      claimSendLock(lockOf({ lane: "compose" }), NONE_OWED, OWNER);
      claimSendLock(lockOf({ lane: "fwd:m1", key: "idem-key-2", fp: "fp-2" }), NONE_OWED, OWNER);
    } finally {
      setItem.mockRestore();
    }

    expect(announced).toEqual(["send.locks", "send.locks"]);
    expect(durabilityLost()).toBe(true);
  });
});
