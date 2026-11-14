/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import { blankSays, openLetter, openSubject } from "./ohbox/_finders.js";

/**
 * A RESURFACED CONVERSATION ROW ALWAYS OPENS — the reported shape, through the shipped shell.
 *
 * Desktop and web, 2026-09-21: under Resurfaced stood a conversation whose newest member was the
 * account's OWN outbound mail — the away responder's answer to a parked message, in Sent. The row
 * was keyed on that member: its face read "Me → …: I'm out of the office", and a click handed the
 * Sent copy's id to the reading column, which resolved it from the three Ohbox groups. A resurfaced
 * conversation's unpinned members are held out of all three, so the column kept "Nothing open."
 * The same id under `/search/m/<id>` rendered the conversation, which is how the miss was placed.
 */

/*
 * Measured here on a `/sync` page carrying exactly that: the inbound original (pinned), the
 * account's auto-reply to it (Sent, newer, same thread), the thread row and the sender's consent.
 * The click must open the conversation with the ORIGINAL in view — a person resurfaces a
 * conversation to see what came back, never their own out-of-office — and the reported web route,
 * which names the Sent copy, must open the conversation too rather than an empty pane.
 */

const COUNTERPARTY = "counterparty@example.invalid";
const ME = "walker@example.invalid";
const ORIGINAL_SUBJECT = "Quarterly figures";

let seq = 0;

/** One `/sync` create over any entity type. */
const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});

const baseMessage = (id: string, over: Record<string, unknown>) => ({
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: "T", messageIdHeader: null,
  to: [], cc: [], unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {},
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  ...over,
});

/**
 * A reported conversation. The pin was raised this morning; the original is dated ten days
 * earlier and the account's answer five minutes after it, so the answer is the newest member.
 */
function ownerShapePage(): Response {
  const pinnedAt = "2026-08-04T07:00:00.000Z";
  const originalAt = "2026-07-25T08:00:00.000Z";
  const answerAt = "2026-07-25T08:05:00.000Z";
  const claim = {
    id: "ms_orig", messageId: "orig", state: "resurfaced", bubbleUpAt: null, setAt: pinnedAt, updatedAt: pinnedAt,
  };
  const creates = [
    create("rule", `rule_${COUNTERPARTY}`, {
      id: `rule_${COUNTERPARTY}`, kind: "sender", match: COUNTERPARTY, destination: "INBOX", priority: 0,
      provenance: "seeded-from-sent", enabled: true,
      stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
    }),
    create("message", "orig", baseMessage("orig", {
      subject: ORIGINAL_SUBJECT,
      from: { name: "A Counterparty", address: COUNTERPARTY },
      to: [{ name: null, address: ME }],
      date: originalAt, arrivedAt: originalAt, sortAt: originalAt, folder: "INBOX",
      snippet: "Here are the figures you asked for.",
      triage: claim,
    })),
    create("message_state", "ms_orig", claim),
    create("message", "own", baseMessage("own", {
      subject: `Re: ${ORIGINAL_SUBJECT}`,
      from: { name: null, address: ME },
      to: [{ name: "A Counterparty", address: COUNTERPARTY }],
      date: answerAt, arrivedAt: answerAt, sortAt: answerAt, folder: "Sent",
      snippet: "I'm out of the office until Monday.",
      autoReplyByUs: true,
    })),
    create("thread", "T", {
      id: "T", accountId: "acct_live_1", rootMessageIdHeader: null, subject: ORIGINAL_SUBJECT,
      messageIds: ["orig", "own"], lastMessageAt: answerAt, participants: [], updatedAt: ISO,
    }),
  ];
  return new Response(
    JSON.stringify({
      changes: { creates, updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The rows of the Ohbox's Resurfaced group, by its listbox's name; a row names its letter by the kit's `data-id`
    and every letter of a folded conversation by its `data-ids` (`Row.tsx`). */
const resurfacedRows = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Resurfaced"] [role="option"][data-id]')];

/** What the resting reading column says, or null while a letter is open (or nothing is said). PARITY L19, DECLARED
    (RULING-JOIN J-3): the resting column says the list's blank ("All read" here), not today's "Nothing open.":
    nothing is open and the column says so. */
const restingSentence = (host: HTMLElement): string | null => blankSays(host);

/** The subject of the conversation the reading column shows (its heading), none while it rests. */
const openSubjects = (host: HTMLElement): string[] => (openLetter(host) === null ? [] : [openSubject(host)]);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await tick(50);
};

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
};

beforeEach(() => {
  installShellEnv();
  seq = 0;
  answerSyncWith(ownerShapePage);
  window.location.hash = "#/ohbox";
});

afterEach(async () => {
  await teardownShellEnv();
});

describe("a Resurfaced conversation whose newest member is the account's own outbound mail", () => {
  /**
   * MUTATION WATCHED, each half on its own and measured: drop `isFromSomeone` from
   * `resurfacedFocus` and the row is faced and opened on the Sent copy again — THIS case
   * reddens; drop the rows' members from `ohboxSurfaceMessages` and the route below rests on
   * "Nothing open.", the reported screenshot — the SECOND case reddens. Both were met in use.
   */
  it("is one row, faced by the original, and a click opens the conversation with the original", async () => {
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();

    const rows = resurfacedRows(host);
    expect(rows, "the conversation is not one Resurfaced row").toHaveLength(1);
    const row = rows[0]!;
    // Both members stand in the row; the row is KEYED on the inbound original, not the Sent copy.
    expect((row.getAttribute("data-ids") ?? "").split(" ").sort()).toEqual(["orig", "own"]);
    expect(row.dataset.id).toBe("orig");
    // The face is the original's words, not the out-of-office standing in for them.
    expect(row.textContent).toContain("Here are the figures");
    expect(row.textContent).not.toContain("out of the office");

    expect(restingSentence(host), "the column does not rest").not.toBeNull();
    await click(row);

    expect(restingSentence(host), "the click left the reading column resting").toBeNull();
    expect(openSubjects(host).join(" | ")).toContain(ORIGINAL_SUBJECT);
    // The route reflects the message the column shows — the original.
    expect(window.location.hash).toBe("#/ohbox/m/orig");
  });

  /**
   * THE WEB REPRO: the reported address bar read `/#/ohbox/m/<the Sent copy's id>` over an empty
   * pane. A route naming ANY member of a conversation the Ohbox shows opens that conversation.
   */
  it("the Ohbox route naming the Sent copy opens the conversation rather than an empty pane", async () => {
    window.location.hash = "#/ohbox/m/own";
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();

    expect(resurfacedRows(host)).toHaveLength(1);
    expect(restingSentence(host), "the route arrived on a resting column").toBeNull();
    expect(openSubjects(host).join(" | ")).toContain(ORIGINAL_SUBJECT);
  });

  /* The rail's tooltip ("0 unread") retired with today's rail, which drew it: the new rail draws no tooltip, and the
     count a person still meets there, the Ohbox's own unread letters, is held by
     packages/app/test/ohbox/above.test.tsx ("the rail's count is the engine's unread letters, withheld until the
     Ohbox may state it"). */
});
