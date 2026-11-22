/** @vitest-environment jsdom */
import { waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { cleanInstallPane, mountInstallPane } from "./_install-pane.js";

/**
 * SETTINGS → DESKTOP NAMES THE MAILBOX THIS INSTALL HOLDS. It rendered `EngineStatus.address`, the
 * seed from the install's settings file, which stays put when the seed is removed while another
 * mailbox remains: the pane named a mailbox the install no longer held. It reads the roster now.
 */

const row = (id: string, address: string, over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id,
  address,
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-02T09:00:00.000Z",
  initialImportCompletedAt: "2026-09-02T09:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z",
  ...over,
} as MailboxFacts);

const SEED = "removed@example.test";
const SURVIVOR = "survivor@example.test";
const status: EngineStatus = {
  state: "serving", mode: "local", credentialState: "ready", mailboxId: "mbx-1", address: SEED,
} as EngineStatus;

function mount(facts: MailboxFacts[] | Promise<MailboxFacts[]>): Promise<HTMLElement> {
  return mountInstallPane({
    status,
    answer: async ({ path }) => path === "/mailboxes" ? { body: { items: await facts } } : undefined,
  });
}

afterEach(cleanInstallPane);

describe("Settings → Desktop names the mailbox this install holds", () => {
  it("shows the running engine and an unreachable mail server from the local roster", async () => {
    const pane = within(await mount([row("mbx-1", SEED, { unreachableSince: "2026-09-02T09:00:00.000Z" })]));
    expect(pane.getByRole("group", { name: "Mail engine" }).textContent).toContain("Running");
    await waitFor(() => expect(pane.getByRole("group", { name: "Connection" }).textContent).toContain("Unreachable"));
  });

  it("the seed was removed while another mailbox remains: the survivor, never the seed", async () => {
    const pane = await mount([
      row("mbx-seed", SEED, { status: "disabled", disabledReason: null }),
      row("mbx-2", SURVIVOR),
    ]);
    await waitFor(() => expect(pane.textContent).toContain(SURVIVOR));
    expect(pane.textContent, "the pane named a mailbox this install no longer holds").not.toContain(SEED);
    expect(pane.querySelector(".set-val-left"), "single mailbox should keep default alignment").toBeNull();
  });

  it("two mailboxes held: both are named and the summary aligns left", async () => {
    const pane = await mount([row("mbx-1", SEED), row("mbx-2", SURVIVOR)]);
    await waitFor(() => expect(pane.textContent).toContain(SURVIVOR));
    expect(pane.textContent).toContain(SEED);
    expect(pane.querySelector(".set-val-left"), "multiple mailbox summary should align left").not.toBeNull();
  });

  it("CONTROL: before the roster has answered, the pane says what it always said", async () => {
    let reply!: (facts: MailboxFacts[]) => void;
    const roster = new Promise<MailboxFacts[]>((resolve) => { reply = resolve; });
    const pane = await mount(roster);
    expect(pane.textContent).toContain(SEED);
    reply([row("mbx-2", SURVIVOR)]);
    await waitFor(() => expect(pane.textContent).toContain(SURVIVOR));
  });
});
