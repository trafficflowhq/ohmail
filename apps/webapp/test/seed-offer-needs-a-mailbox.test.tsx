/** @vitest-environment jsdom */

/**
 * THE SENT-MAIL REVIEW NEEDS A MAILBOX TO REVIEW. On an account with none it said "You've written
 * to 0 people" over the whole stage; with none it is not owed, and the sync strip's own
 * "No mailbox connected" sentence is what that person reads.
 */

import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSeedOffer, type SeedOffer } from "../app/shell/seed-offer";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWED = { demo: false, known: true, supported: true, seedConfirmedAt: null };
let offer: SeedOffer | null = null;
function Probe(props: { input: Parameters<typeof useSeedOffer>[0] }) {
  offer = useSeedOffer(props.input);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
async function load(input: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe input={input as never} />); });
}

beforeEach(() => { window.localStorage.clear(); setStorageOwner("acct_a"); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; offer = null;
  resetStorageOwnerForTest();
  window.localStorage.clear();
});

describe("the seed offer on an account with no mailbox", () => {
  it("is not owed", async () => {
    await load({ ...OWED, hasMailbox: false });
    expect(offer!.owed).toBe(false);
  });

  it("CONTROL: with a mailbox it is owed as before", async () => {
    await load({ ...OWED, hasMailbox: true });
    expect(offer!.owed).toBe(true);
  });

  it("the shell hands the offer whether a mailbox exists", async () => {
    const shell = fs.readFileSync(path.join(HERE, "..", "app/shell/AppShell.tsx"), "utf8");
    const call = shell.slice(shell.indexOf("useSeedOffer({"), shell.indexOf("useSeedOffer({") + 240);
    expect(call).toMatch(/hasMailbox: hasLiveMailbox\(facts\)/);
    const { hasLiveMailbox } = await import("../app/shell/seed-offer");
    expect(hasLiveMailbox(null), "unread is not known").toBeNull();
    expect(hasLiveMailbox([])).toBe(false);
    expect(hasLiveMailbox([{ status: "disabled" }]), "a removed mailbox is none").toBe(false);
    expect(hasLiveMailbox([{ status: "disabled" }, { status: "connected" }])).toBe(true);
  });
});
