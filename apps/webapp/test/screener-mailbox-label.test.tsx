/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
afterEach(teardownShellEnv);

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
    within(option).queryAllByText(/^(?:Work|home@fixture\.example)$/).map((badge) => badge.textContent ?? ""));
}

describe("the Screener list names the mailbox a stranger wrote to", () => {
  it("draws each row's own mailbox, and they differ", async () => {
    await mount(TWO);
    const drawn = badges();
    expect(drawn).toHaveLength(2);
    // The mailbox's label where it has one, the bare address where it has none — the fallback the
    // "me" chip already keeps, and the reason the fixture gives only one of them a display name.
    expect(new Set(drawn)).toEqual(new Set(["Work", HOME.address]));
  });

  it("the badge carries the whole sentence, from the namespace that owns it", async () => {
    await mount(TWO);
    expect(within(row("m1")).getByTitle("Delivered to Work").textContent).toBe("Work");
    expect(within(row("m2")).getByTitle(`Delivered to ${HOME.address}`).textContent).toBe(HOME.address);
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
    const caption = within(reading).getByText("Delivered to Work", { exact: true });
    const letter = within(reading).getByRole("article");
    expect(caption.compareDocumentPosition(letter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
