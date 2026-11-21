/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import { fireEvent, within } from "@testing-library/react";
import { typeInto } from "./fixtures/rich-editor-driver";
import { barVerb, letterShown, menuItems, readingColumn, seatedList } from "./ohbox/_finders.js";

/**
 * FORWARD SENDS THE MESSAGE THE CONVERSATION WAS OPENED AT, through the shipped shell and the real
 * engine. `a1` is from Lena, unread, with a file; `x2` is newer and is our away answer, our calendar
 * acknowledgement, our own reply, a stranger's reply held in the Screener, or a member filed to Junk.
 * The Ohbox row opens `a1`; the bar's Forward and ⇧F forward `a1` (the dock's `data-reply-for`, which
 * the send carries as `forwardOf`, the message whose parts go with it). A search landing forwards its
 * hit. Recomputing "the newest" over the whole thread forwarded `x2` (HIGH 1, 2).
 *
 * The mounted frame exposes the forward's target in the actual send request (`forwardOfMessageId`),
 * as `conversation-bar-acts-on-the-opened-panel.test.tsx` also checks.
 */

const ME = "walker@example.invalid";
const LENA = { name: "Lena", address: "lena@example.invalid" };
const OLDER = "2026-08-03T08:00:00.000Z";
const NEWER = "2026-08-03T09:00:00.000Z";
let seq = 0;

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
const message = (id: string, at: string, over: Record<string, unknown>) => create("message", id, {
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: "T", messageIdHeader: null,
  subject: "Q3 plan", from: LENA, to: [{ name: null, address: ME }], cc: [], date: at, arrivedAt: at, sortAt: at,
  folder: "INBOX", snippet: `the words of ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
});
const consent = (address: string) => create("rule", `rule_${address}`, {
  id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
  provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});
const thread = (ids: string[]) => create("thread", "T", {
  id: "T", accountId: "acct_live_1", rootMessageIdHeader: null, subject: "Q3 plan", messageIds: ids,
  lastMessageAt: NEWER, participants: [], updatedAt: ISO,
});
const pageOf = (creates: unknown[]) => (): Response => new Response(
  JSON.stringify({ changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO }),
  { status: 200, headers: { "content-type": "application/json" } },
);

const rowA1 = () => message("a1", OLDER, { unread: true, hasAttachments: true, attachmentCount: 1 });
const OURS = { from: { name: null, address: ME }, to: [LENA], folder: "Sent" };
const laterX2: Record<string, Record<string, unknown>> = {
  "our away answer": { ...OURS, subject: "Re: Q3 plan", autoReplyByUs: true },
  "our calendar acknowledgement": { ...OURS, subject: "Accepted: Q3 plan", itipReplyHeader: true },
  "our own reply": { ...OURS, subject: "Re: Q3 plan" },
  "a stranger's reply held in the Screener": { from: { name: "S", address: "s@elsewhere.invalid" }, folder: "ohmail/Screener" },
  "a member filed to Junk": { from: { name: "J", address: "j@elsewhere.invalid" }, folder: "ohmail/Quarantine" },
};

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };
const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};
const rowOf = (host: HTMLElement, id: string): HTMLElement => {
  const row = host.querySelector<HTMLElement>(`[role="listbox"] :is(.row, [role=option])[data-id="${id}"]`);
  expect(row, `the Ohbox row ${id}`).toBeTruthy();
  return row!;
};
/** The bodies of every send that named a forwarded letter, in order. */
const forwardsSent = (): Array<string | null> =>
  (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }).mock.calls
    .flatMap(([, init]) => (typeof init?.body === "string" && init.body.includes("forwardOfMessageId") ? [init.body] : []))
    .map((body) => (JSON.parse(body) as { forwardOfMessageId?: string | null }).forwardOfMessageId ?? null);
/**
 * The message the open forward is bound to: what the send forwards. The new shell's forward is `write`'s sheet after
 * the conversation (a section named Forward), which carries no letter's id of its own: the forward is sent as a person
 * sends it (a recipient, a line, Send on the panel), and the id is the one its ONE send names on the wire.
 */
const docked = async (host: HTMLElement): Promise<string | null> => {
  const sheet = readingColumn(host)?.querySelector<HTMLElement>('section[aria-label="Forward"]') ?? null;
  if (sheet === null) return null;
  const before = forwardsSent().length;
  /* The To line by its name: a combobox while the account offers people, a plain field once it offers none. */
  const to = sheet.querySelector<HTMLInputElement>('input[aria-label="To"]');
  expect(to, "the forward's To line").toBeTruthy();
  await act(async () => { fireEvent.change(to!, { target: { value: "mila@example.invalid, " } }); });
  await act(async () => { typeInto(within(sheet).getByRole("textbox", { name: "Forward body" }), "For you"); });
  /* An open reply's verbs stand in the letter's panel: Send is there. */
  const send = barVerb(host, "Send");
  expect(send, "the forward's Send").toBeTruthy();
  await click(send!);
  /* The forward leaves: its sheet goes once the send is handed off, so the next forward opens a sheet of its own. */
  for (let i = 0; i < 40 && readingColumn(host)?.querySelector('section[aria-label="Forward"]'); i++) await tick(50);
  const sent = forwardsSent().slice(before);
  return sent.length === 1 ? sent[0]! : null;
};
const pressBarForward = async (host: HTMLElement): Promise<void> => {
  const button = barVerb(host, "Forward");
  expect(button, "the bar's Forward").toBeTruthy();
  await click(button!);
};
/** A row press, as a person makes it at this width: the first click selects, the second opens. */
const openRow = async (host: HTMLElement, id: string): Promise<void> => {
  await click(rowOf(host, id));
  await click(rowOf(host, id));
};

/* THE SHELL LOADS ONCE, under its own bound: a cold import inside a case's 5 s strands the mount and
   reddens the cases after it (`thread-inline-forward.test.tsx` has the same fix). */
beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);

beforeEach(() => {
  installShellEnv();
  seq = 0;
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

describe("the bar's Forward in a conversation opened from its Ohbox row", () => {
  for (const [label, over] of Object.entries(laterX2)) {
    it(`with ${label} newer than a1, the row opens a1 and Forward takes a1`, async () => {
      answerSyncWith(pageOf([consent(LENA.address), rowA1(), message("x2", NEWER, over), thread(["a1", "x2"])]));
      const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
      await settle();
      await openRow(host, "a1");
      await pressBarForward(host);
      expect(await docked(host)).toBe("a1");
    }, 30_000);
  }

  it("the bar agrees with the opened message's own Forward, and our own reply's panel forwards our reply", async () => {
    /* Each forward is read by its one send, and a send this test's server answers with nothing stays unconfirmed and
       holds the next: each Forward is pressed over its own mount of the same conversation, opened at a1. */
    const opened = async (): Promise<HTMLElement> => {
      await teardownShellEnv();
      installShellEnv();
      seq = 0;
      window.location.hash = "#/ohbox";
      answerSyncWith(pageOf([consent(LENA.address), rowA1(), message("x2", NEWER, laterX2["our own reply"]!), thread(["a1", "x2"])]));
      const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
      await settle();
      await openRow(host, "a1");
      return host;
    };
    const bar = await opened();
    await pressBarForward(bar);
    expect(await docked(bar)).toBe("a1");
    const panelForward = async (id: string): Promise<string | null> => {
      const host = await opened();
      const panel = letterShown(host, id);
      expect(panel, `the panel of ${id}`).toBeTruthy();
      // The letter's own menu: the button named Message on its head.
      await click(panel!.querySelector<HTMLElement>('button[aria-label="Message"]')!);
      const item = menuItems().find((b) => b.textContent?.trim() === "Forward");
      expect(item, `Forward on the panel of ${id}`).toBeTruthy();
      await click(item!);
      return await docked(host);
    };
    expect(await panelForward("a1")).toBe("a1");
    expect(await panelForward("x2")).toBe("x2");
  }, 30_000);

  it("⇧F on the row the cursor is on, with no reader, forwards a1", async () => {
    answerSyncWith(pageOf([consent(LENA.address), rowA1(), message("x2", NEWER, laterX2["our away answer"]!), thread(["a1", "x2"])]));
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();
    await key("j");
    expect(seatedList(host), "no reader sheet: the list stands").not.toBeNull();
    await key("F", { shiftKey: true });
    expect(await docked(host)).toBe("a1");
  }, 30_000);

  it("a Resurfaced conversation ending in our away answer forwards the pinned original", async () => {
    const pin = { id: "ms_a1", messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: ISO, updatedAt: ISO };
    answerSyncWith(pageOf([
      consent(LENA.address), message("a1", OLDER, { hasAttachments: true, attachmentCount: 1, triage: pin }), create("message_state", "ms_a1", pin),
      message("x2", NEWER, laterX2["our away answer"]!), thread(["a1", "x2"]),
    ]));
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();
    await openRow(host, "a1");
    await pressBarForward(host);
    expect(await docked(host)).toBe("a1");
  }, 30_000);
});

describe("a message opened any other way forwards itself", () => {
  it("a search landing on the older message of a conversation forwards that message, not the row's", async () => {
    answerSyncWith(pageOf([
      consent(LENA.address), message("h1", OLDER, { hasAttachments: true, attachmentCount: 1 }),
      message("h2", NEWER, { unread: true }), thread(["h1", "h2"]),
    ]));
    window.location.hash = "#/ohbox/m/h1";
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();
    expect(host.querySelector<HTMLElement>('[role="listbox"] :is(.row, [role=option])[data-id]')?.dataset.id, "the premise: the row's own target is h2").toBe("h2");
    await pressBarForward(host);
    expect(await docked(host)).toBe("h1");
  }, 30_000);
});
