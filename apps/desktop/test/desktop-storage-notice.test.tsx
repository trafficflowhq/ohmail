/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { DesktopStorageNotice } from "../src/DesktopStorageNotice.js";
import type { StorageFacts } from "../../webapp/app/shell/storage-state";

/**
 * THE EMPTIED-TEXT NOTICE ON THE CLOUD DOOR: the words follow the current usage and the subscription.
 * When the current cap is not what emptied the text it says what happened then and offers nothing; a past-due or
 * grace subscription is offered no plan and no add-on; a build that may not link out offers neither.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => void) => void }).act;
const h = React.createElement;

const EMPTIED = {
  usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
  firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04" as string | null, withheldOnArrival: 0, upgrade: "plan" as const,
  emptyingNow: true, planLimitBytes: null as number | null, limitDropsAt: null as string | null,
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

function draw(facts: StorageFacts, lifecycleState: string, linksOut = true): string {
  act(() => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, children: h(DesktopStorageNotice, { facts, lifecycleState, linksOut }),
    }));
  });
  return host.textContent ?? "";
}

describe("the desktop's emptied-text notice", () => {
  it("at the cap of an active plan: the cap, and the plan or the add-on", () => {
    const said = draw(EMPTIED, "active");
    expect(said).toContain("To stay within your plan's 2 GB, ohmail no longer stores the text of your 80,000 oldest letters.");
    expect(said).toContain("Text is kept for letters from April 2019 on.");
    expect(said).toContain("A bigger plan or the storage add-on keeps more text from now on.");
  });

  it("letters that arrived while the storage was full are counted apart from the oldest", () => {
    const said = draw({ ...EMPTIED, withheldOnArrival: 5 }, "active");
    expect(said).toContain("ohmail no longer stores the text of your 79,995 oldest letters.");
    expect(said).toContain("Text is kept for letters from April 2019 on, apart from 5 letters that arrived while your storage was full.");
  });

  it("upgraded to 10 GB, 19% used: what happened then, no cap and no offer", () => {
    const said = draw({ ...EMPTIED, limitBytes: 10_000_000_000, emptyingNow: false }, "active");
    expect(said).toContain("To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(said).not.toContain("10 GB");
    expect(said).not.toMatch(/bigger plan|add-on/);
  });

  it("past due or in grace, and a build that may not link out: no plan and no add-on", () => {
    for (const state of ["past_due", "grace"]) expect(draw(EMPTIED, state), state).not.toMatch(/bigger plan|add-on/);
    expect(draw(EMPTIED, "active", false)).not.toMatch(/bigger plan|add-on|Manage subscription/);
  });

  it("near the cap: the same upgrade message; on the largest plan the add-on alone", () => {
    const near = { ...EMPTIED, usedBytes: 1_820_000_000, emptiedForSpace: 0, keptFrom: null };
    const said = draw(near, "active");
    expect(said).toContain("Storage is nearly full.");
    expect(said).toContain("A bigger plan or the storage add-on keeps more text from now on.");
    const pro = draw({ ...near, limitBytes: 10_000_000_000, usedBytes: 9_500_000_000, upgrade: "addon" as const }, "active");
    expect(pro).toContain("The storage add-on keeps more text from now on.");
    expect(pro).not.toContain("bigger plan");
  });

  it("inside the trial's floor: when the plan's own limit applies, before anything is emptied", () => {
    const said = draw({
      ...EMPTIED, usedBytes: 3_500_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 0, emptyingNow: false,
      planLimitBytes: 2_000_000_000, limitDropsAt: "2026-11-08T12:00:00.000Z",
    }, "active");
    expect(said).toContain("Until November 8, 2026, ohmail keeps up to 4 GB of letter text. From then on your plan keeps 2 GB");
    expect(said).toContain("A bigger plan or the storage add-on keeps more text from now on.");
  });

  it("a build that may not link out still says the storage is nearly full, with no purchase", () => {
    const said = draw({ ...EMPTIED, usedBytes: 1_820_000_000, emptiedForSpace: 0 }, "active", false);
    expect(said).toContain("Storage is nearly full.");
    expect(said).not.toMatch(/bigger plan|add-on|Manage subscription/);
  });

  it("state A, far below the cap, no trim recorded: the plain count, no offer, no press", () => {
    const said = draw({
      ...EMPTIED, usedBytes: 1_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 3, firstEmptiedAt: null, keptFrom: null,
      emptyingNow: false,
    } as StorageFacts, "active");
    expect(said).toContain("The text of 3 letters is not stored here.");
    expect(said).not.toMatch(/oldest|at the time|bigger plan|add-on|bring back|Manage subscription/);
  });

  it("state B, a trial near its plan's own limit, no trim recorded: the plain count, the offer, no restore line", () => {
    const said = draw({
      ...EMPTIED, usedBytes: 1_900_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 75_000, firstEmptiedAt: null, keptFrom: null,
      emptyingNow: false, planLimitBytes: 2_000_000_000, limitDropsAt: null,
    } as StorageFacts, "trialing");
    expect(said).toContain("The text of 75,000 letters is not stored here.");
    expect(said).not.toMatch(/your 75,000 oldest|at the time|bring back/);
    expect(said).toContain("A bigger plan keeps more text from now on.");
    expect(said).toContain("Manage subscription");
  });

  it("put away under the earlier release, state A stays away", async () => {
    const { localStorageDoor } = await import("../../webapp/app/shell/durable");
    localStorageDoor("storage.notice").set("ohmail.storage.local.emptiedNotice", "1");
    const said = draw({
      ...EMPTIED, usedBytes: 1_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 3, firstEmptiedAt: null, keptFrom: null,
      emptyingNow: false,
    } as StorageFacts, "active");
    expect(said).toBe("");
  });
});
