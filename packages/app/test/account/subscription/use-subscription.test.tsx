/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ManageOutcome } from "../../../src/account/contract.js";
import type { SubscriptionDoor } from "../../../src/account/subscription/model.js";
import { useSubscription } from "../../../src/account/subscription/use-subscription.js";
import { NONE } from "../../../src/host/index.js";
import { fakeSubscriptionDoor, held, READS, THROWS, TRIAL, type PlansRead } from "./fake-door.js";

afterEach(cleanup);

function mounted(door: SubscriptionDoor, strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => useSubscription(door), { reactStrictMode: strict });
}
/** Every answer on its way taken in. */
const settled = (doing: () => void = () => {}) =>
  act(async () => {
    doing();
  });

describe("the press that opens the account page", () => {
  it("is not made by opening the pane", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE, manages: ["left"] });
    mounted(door);
    await settled();
    expect(door.picks()).toEqual([]);
  });

  it("is made by the press, once at a time, with the verb off while the address is made", async () => {
    const answer = held<ManageOutcome>();
    const door = fakeSubscriptionDoor({ plans: NONE, manages: [answer.promise, "left"] });
    const { result } = mounted(door);
    act(() => result.current.manage());
    expect(result.current.opening).toBe(true);
    act(() => result.current.manage());
    expect(door.picks()).toHaveLength(1);
    await settled(() => answer.settle("left"));
    expect(result.current.opening).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  it("says a press that could not open the page, and the next press takes that back", async () => {
    const answer = held<ManageOutcome>();
    const door = fakeSubscriptionDoor({ plans: NONE, manages: ["failed", answer.promise] });
    const { result } = mounted(door);
    await settled(() => result.current.manage());
    expect(result.current.failed).toBe(true);
    act(() => result.current.manage());
    expect(result.current.failed).toBe(false);
    await settled(() => answer.settle("left"));
    expect(door.picks()).toHaveLength(2);
  });

  it("says nothing where no page is served: the shell takes the pane away", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE, manages: ["nowhere"] });
    const { result } = mounted(door);
    await settled(() => result.current.manage());
    expect(result.current.failed).toBe(false);
    expect(result.current.opening).toBe(false);
  });

  it("a press the door could not answer could not open the page", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE, manages: [THROWS] });
    const { result } = mounted(door);
    await settled(() => result.current.manage());
    expect(result.current.failed).toBe(true);
  });

  it("hands the door the plan and the interval it was given, and nothing where it was given none", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE, manages: ["failed", "failed"] });
    const { result } = mounted(door);
    await settled(() => result.current.manage({ plan: "plus", interval: "year" }));
    await settled(() => result.current.manage());
    expect(door.picks()).toEqual([{ plan: "plus", interval: "year" }, undefined]);
  });

  it("a pane left while the address is made steps nothing afterwards", async () => {
    const answer = held<ManageOutcome>();
    const door = fakeSubscriptionDoor({ plans: NONE, manages: [answer.promise] });
    const { result, unmount } = mounted(door);
    act(() => result.current.manage());
    const opened = result.current;
    unmount();
    await settled(() => answer.settle("failed"));
    expect(door.picks()).toHaveLength(1);
    expect(opened.opening).toBe(true);
  });

  it("a press on a pane that was left asks nothing", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE, manages: ["left"] });
    const { result, unmount } = mounted(door);
    const { manage } = result.current;
    unmount();
    await settled(() => manage());
    expect(door.picks()).toEqual([]);
  });

  it("works where the tree is mounted twice over: the guard is armed in the effect", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE, manages: ["failed"] });
    const { result } = mounted(door, true);
    await settled(() => result.current.manage());
    expect(door.picks()).toHaveLength(1);
    expect(result.current.failed).toBe(true);
  });
});

describe("the plans' read", () => {
  it("asks nothing where the host has no read of the plans", async () => {
    const door = fakeSubscriptionDoor({ plans: NONE });
    const { result } = mounted(door);
    await settled();
    expect(result.current.plans).toEqual({ at: "none" });
    act(() => result.current.retryPlans());
    expect(door.reads()).toBe(0);
  });

  it("asks once as the pane opens, and once only, whatever the standing does after", async () => {
    const door = fakeSubscriptionDoor({ plans: [READS.card] });
    const { result } = mounted(door);
    expect(result.current.plans).toEqual({ at: "loading" });
    await settled();
    act(() => door.show({ ...TRIAL, mailboxes: 10 }));
    await settled();
    expect(door.reads()).toBe(1);
    expect(result.current.status?.mailboxes).toBe(10);
  });

  it("draws each of the read's answers as it came, in the account's own interval", async () => {
    for (const read of [READS.notForSale, READS.unanswered, READS.card] as PlansRead[]) {
      const { result } = mounted(fakeSubscriptionDoor({ plans: [read] }));
      await settled();
      expect(result.current.plans).toEqual({
        at: "read",
        answer: read.ok ? read.value : null,
        interval: "month",
      });
      cleanup();
    }
    const yearly = {
      ...READS.card,
      value: { ...READS.card.value, current: { plan: "solo", interval: "year", addonUnits: 1 } },
    } as const;
    const { result } = mounted(fakeSubscriptionDoor({ plans: [yearly] }));
    await settled();
    expect(result.current.plans).toMatchObject({ at: "read", interval: "year" });
  });

  it("keeps a read that failed as one Try again asks once more, and the press stays", async () => {
    const door = fakeSubscriptionDoor({ plans: [READS.unavailable, READS.card], manages: ["left"] });
    const { result } = mounted(door);
    await settled();
    expect(result.current.plans).toEqual({ at: "unavailable" });
    await settled(() => result.current.retryPlans());
    expect(door.reads()).toBe(2);
    expect(result.current.plans).toMatchObject({ at: "read" });
    await settled(() => result.current.retryPlans());
    expect(door.reads()).toBe(2);
    await settled(() => result.current.manage());
    expect(door.picks()).toHaveLength(1);
  });

  it("a read the door could not answer could not read the prices", async () => {
    const { result } = mounted(fakeSubscriptionDoor({ plans: [THROWS] }));
    await settled();
    expect(result.current.plans).toEqual({ at: "unavailable" });
  });

  it("chooses month or year for the prices shown, once the plans are read", async () => {
    const door = fakeSubscriptionDoor({ plans: [READS.card] });
    const { result, rerender } = renderHook(
      (current: Pick<SubscriptionDoor, "plans">) => useSubscription({ ...door, ...current }),
      { initialProps: { plans: door.plans } },
    );
    act(() => result.current.choose("year"));
    expect(result.current.plans).toEqual({ at: "loading" });
    await settled();
    act(() => result.current.choose("year"));
    expect(result.current.plans).toMatchObject({ at: "read", interval: "year" });
    const refreshed = fakeSubscriptionDoor({ plans: [READS.card] });
    // A new access answer supplies a fresh plans read for the same open pane.
    await settled(() => rerender({ plans: refreshed.plans }));
    expect(refreshed.reads()).toBe(1);
    expect(result.current.plans).toMatchObject({ at: "read", interval: "year" });
  });
});

describe("the standing", () => {
  it("follows the access answer as it changes, and is nothing before its first answer", () => {
    const door = fakeSubscriptionDoor({ status: null, plans: NONE });
    const { result } = mounted(door);
    expect(result.current.status).toBeNull();
    act(() => door.show(TRIAL));
    expect(result.current.status).toEqual(TRIAL);
  });
});
