/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { DesktopStorageNotice } from "../src/DesktopStorageNotice.js";

/**
 * THE EMPTIED-TEXT NOTICE ON THE CLOUD DOOR: the words follow the current usage and the subscription.
 * Below the current cap's trim band it says what happened then and offers nothing; a past-due or
 * grace subscription is offered no plan and no add-on; a build that may not link out offers neither.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => void) => void }).act;
const h = React.createElement;

const EMPTIED = {
  usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
  firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04", withheldOnArrival: 0,
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

function draw(facts: typeof EMPTIED, lifecycleState: string, linksOut = true): string {
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
    const said = draw({ ...EMPTIED, limitBytes: 10_000_000_000 }, "active");
    expect(said).toContain("To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(said).not.toContain("10 GB");
    expect(said).not.toMatch(/bigger plan|add-on/);
  });

  it("past due or in grace, and a build that may not link out: no plan and no add-on", () => {
    for (const state of ["past_due", "grace"]) expect(draw(EMPTIED, state), state).not.toMatch(/bigger plan|add-on/);
    expect(draw(EMPTIED, "active", false)).not.toMatch(/bigger plan|add-on|Manage subscription/);
  });
});
