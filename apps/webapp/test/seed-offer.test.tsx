/** @vitest-environment jsdom */

/**
 * THE SEED OFFER: WHEN THE SENT-MAIL REVIEW TAKES THE STAGE, AND WHAT "NOT NOW" KEEPS.
 *
 * "Not now" lived in the shell's state alone, so every reload put the review back over every
 * view. It is now kept on this device for the account (`seedNotNowKey`); the Settings entry still
 * opens the review. A review that found nobody to decide about hands the stage back for this tab
 * only — the sent mail may still be arriving, so nothing is stored for it.
 */

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedNotNowKey, useSeedOffer, type SeedOffer } from "../app/shell/seed-offer";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWED = { demo: false, known: true, supported: true, seedConfirmedAt: null, hasMailbox: true };
let offer: SeedOffer | null = null;
function Probe(props: { input?: Parameters<typeof useSeedOffer>[0] }) {
  offer = useSeedOffer(props.input ?? OWED);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
/** A mount is one page load: a fresh tree over whatever this device's storage holds. */
async function load(input?: Parameters<typeof useSeedOffer>[0]) {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe input={input} />); });
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageOwner("acct_a");
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; offer = null;
  resetStorageOwnerForTest();
  window.localStorage.clear();
});

describe("the seed offer", () => {
  it("is owed to an account that never answered it", async () => {
    await load();
    expect(offer!.owed).toBe(true);
  });

  it("'Not now' holds across a reload on this device", async () => {
    await load();
    await act(async () => { offer!.later(); });
    expect(offer!.owed).toBe(false);
    expect(window.localStorage.getItem(seedNotNowKey("acct_a"))).toBe("1");
    await load();
    expect(offer!.owed, "the reload put the review back over the view").toBe(false);
  });

  it("…for that account only: another account on this browser is still asked", async () => {
    await load();
    await act(async () => { offer!.later(); });
    setStorageOwner("acct_b");
    await load();
    expect(offer!.owed).toBe(true);
  });

  it("the Settings entry opens it again after 'Not now'", async () => {
    await load();
    await act(async () => { offer!.later(); });
    await act(async () => { offer!.reopen(); });
    expect(offer!.owed).toBe(true);
  });

  it("nobody to decide about hands the stage back for this tab and stores nothing", async () => {
    await load();
    await act(async () => { offer!.nothingToDecide(); });
    expect(offer!.owed).toBe(false);
    expect(window.localStorage.getItem(seedNotNowKey("acct_a"))).toBeNull();
    await load();
    expect(offer!.owed, "a later load asks the server again").toBe(true);
  });

  it("is never owed on the demo, before the server answered, where it cannot run, or once confirmed", async () => {
    for (const input of [
      { ...OWED, demo: true }, { ...OWED, known: false }, { ...OWED, supported: false },
      { ...OWED, seedConfirmedAt: "2026-09-25T09:00:00.000Z" },
    ]) {
      await load(input);
      expect(offer!.owed, JSON.stringify(input)).toBe(false);
    }
  });
});
