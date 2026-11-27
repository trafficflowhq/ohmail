/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { within } from "@testing-library/react";
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type SyncChange } from "@ohmail/client-engine";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import {
  ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

const NOW = new Date(ISO);
let seq = 0;

/** TWO MAILBOXES WHOSE ADDRESSES DIFFER — a fixture where they agree measures alignment. */
const WORK = mailbox({ id: "mbx-work", address: "work@fixture.example", displayName: "Work", lastSyncAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO });
const HOME = mailbox({ id: "mbx-home", address: "home@fixture.example", displayName: null, lastSyncAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO });
const TWO: MailboxFacts[] = [WORK, HOME];

function held(id: string, from: string, mailboxId: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId, threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-04T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(mail.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

let host: HTMLElement;
const MAIL = [
  held("m1", "one@stranger.example", WORK.id, 9),
  held("m2", "two@stranger.example", HOME.id, 8),
];

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(async () => { await teardownShellEnv(); vi.unstubAllGlobals(); });

async function mount(facts: MailboxFacts[] | null, select = false) {
  window.location.hash = "#/screener";
  host = await mountShell(facts ?? [], {
    engine: await engineWith(MAIL), suggestWire: "none", junkWire: "none",
    ...(facts === null ? { probe: () => new Promise<MailboxFacts[]>(() => {}) } : {}),
  });
  await tick(50);
  if (select) {
    await act(async () => { row("m1").click(); });
    await tick(0);
  }
}

function row(id: string): HTMLElement {
  const list = within(host).getByRole("listbox", { name: "Screener" });
  return within(list).getByRole("option", { name: new RegExp(`Subject ${id}$`) });
}

function badges(): string[] {
  return [row("m1"), row("m2")].flatMap((option) =>
    within(option).queryAllByText(/^(?:Work|home)$/).map((badge) => badge.textContent ?? ""));
}

describe("the Screener list names the mailbox a stranger wrote to", () => {
  it("draws each row's own mailbox, and they differ", async () => {
    await mount(TWO);
    const drawn = badges();
    expect(drawn).toHaveLength(2);
    // The row uses the mailbox's label, or its short name when the mailbox has no label.
    expect(new Set(drawn)).toEqual(new Set(["Work", "home"]));
  });

  it("at phone width the mailbox badge yields two thirds of the row and ellipsizes a long label", async () => {
    vi.stubGlobal("innerWidth", 414);
    const label = "Customer enquiries for the whole company";
    await mount([{ ...WORK, displayName: label }, HOME]);

    const badge = within(row("m1")).getByTitle(`Delivered to ${label}`);
    expect(badge.textContent).toBe(label);
    expect(badge.classList.contains("sc-mailbox-badge")).toBe(true);
    const screenerCss = readFileSync("packages/app/src/screener/screener.css", "utf8");
    expect(screenerCss).toMatch(/:root\[data-device="phone"\] \.sc-mailbox-badge\s*\{[^}]*max-inline-size:\s*33\.333%/);
    expect(within(badge).getByText(label).hasAttribute("data-truncate")).toBe(true);
    const tagCss = readFileSync("packages/ui/src/base/Primitives/tag.css", "utf8");
    expect(tagCss).toMatch(/:root\[data-device="phone"\] \.oh-tag\[data-truncate\]\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/);
  });

  it("the badge carries the whole sentence, from the namespace that owns it", async () => {
    await mount(TWO);
    expect(within(row("m1")).getByTitle("Delivered to Work").textContent).toBe("Work");
    expect(within(row("m2")).getByTitle("Delivered to home").textContent).toBe("home");
  });

  /**
   * THE `> 1` GATE, WHICH LIVES IN THE RESOLVER. One mailbox is no question, so the answer is
   * silence — and `null` facts (the demo, a surface with no `GET /mailboxes`) is the same
   * silence. Two arms, because they reach the resolver by different routes.
   */
  it("says nothing on a one-mailbox account", async () => {
    await mount([WORK]);
    expect(badges()).toEqual([]);
  });

  it("says nothing where the mailboxes cannot be named at all", async () => {
    await mount(null);
    expect(badges()).toEqual([]);
  });

  it("the sheet states it too, above the mail the decision is about", async () => {
    await mount(TWO, true);
    const reading = within(host).getByRole("region", { name: "Reading" });
    const caption = within(reading).getByRole("note", { name: "Delivered to Work" });
    expect(caption.textContent).toBe("Delivered to Work");
    const letter = within(reading).getByRole("article");
    expect(caption.compareDocumentPosition(letter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
