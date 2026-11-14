/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { messageDisplayTime } from "@ohmail/client-engine";
import { mountReader } from "../../../packages/app/test/reader/support/mail.js";
import { metaLine } from "../app/shell/format";

/**
 * "Ohbox ·", AND THE SEPARATOR THAT INTRODUCED NOTHING.
 *
 * ── WALKED ON A LIVE ACCOUNT, 2026-08-04 ────────────────────────────────────────────────
 *
 * A message with **no `Date:` header** rendered a blank stamp and a dangling separator. Spam
 * and scripts omit `Date:` routinely; it is optional in practice and nothing in this pipeline
 * substitutes for it. `packages/core/src/mime.ts:459` writes `parsed.date ?? null`,
 * `dto/materialize.ts` passes the null through, and `messageDisplayTime` answers `""` —
 * correctly, because there is no instant to format. Three surfaces then interpolated that empty
 * string into templates that had already committed to the separator.
 *
 * A dangling "·" is not cosmetic. It is the interface asserting a second fact follows, when
 * there is none — the same untrue statement as this slice's five siblings, made in punctuation.
 *
 * ── WHERE THE FALLBACK BELONGS, AND WHERE IT DOES NOT ───────────────────────────────────
 *
 * The acceptance asks for IMAP INTERNALDATE and that is the right value — but it is not
 * reachable from any surface, and it is not reachable from the DTO either:
 *
 *  1. **Nothing persists it.** INTERNALDATE is read only for ORDERING, into an in-memory cache
 *     (`arrivalKey`, `packages/core/src/adapters/imap.ts:70`). `messages` has no column for it.
 *     The only always-present stamps `dto/materialize.ts` could coalesce to are `createdAt` /
 *     `updatedAt` — when OUR worker wrote the row — and `imap.ts:44-48` already records why
 *     that is the wrong answer: an imported mailbox "leaves every message stamped with the
 *     import time".
 *  2. **A non-null `MessageDTO.date` would desynchronise two orderings.** The server sorts by
 *     `messages.date`, still NULL; the client's `byDateDesc` reads a missing date as 0, i.e.
 *     oldest. A value synthesized on the wire would put an undated message NEWEST on the client
 *     and OLDEST on the server, and contract §5.2 makes the server's order the order.
 *
 * So the DTO is deliberately unchanged, the real repair is owed at ingest — where INTERNALDATE
 * is in hand and one write fixes every surface — and this file holds the display rule that
 * stops the product asserting a fact it does not have in the meantime. It stays correct after
 * the ingest fix lands: a date that is always present simply means no part is ever dropped.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");

/** A real-shaped row. `date: null` is the whole point and is the DEFAULT here. */
function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: `${over.id}@spam.invalid` },
    to: [], cc: [], date: null, folder: "INBOX",
    snippet: "no date header on this one", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  } as EngineMessage;
}

let zone: string | undefined;

beforeEach(() => {
  /* The DATED sibling's stamp renders in the reader's zone (the platform's) on the reader's clock;
     both pinned so this file keeps testing the SEPARATOR rather than the machine's timezone. */
  zone = process.env.TZ;
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("the premise: an undated message really does reach the client with no stamp", () => {
  it("`messageDisplayTime` answers the empty string, and that is correct", () => {
    // Not a defect to fix in the formatter: there is no instant, so any string it invented
    // would be a claim about when a message was sent. The defect is what the CALLERS did with
    // the empty answer.
    expect(messageDisplayTime(msg({ id: "a" }), NOW, "UTC")).toBe("");
    expect(messageDisplayTime(msg({ id: "a", date: "not-a-date" }), NOW, "UTC")).toBe("");
  });
});

describe("the separator is never printed without a value on both sides", () => {
  it("metaLine drops empty parts rather than spacing around them", () => {
    /**
     * Mutation: make `metaLine` a plain `parts.join(" · ")`. Every assertion below except the
     * first goes red, with exactly the strings the walk found — "Ohbox · " and "thread (3) · ".
     */
    expect(metaLine("Ohbox", "09:12")).toBe("Ohbox · 09:12");
    expect(metaLine("Ohbox", "")).toBe("Ohbox");
    expect(metaLine("", "09:12")).toBe("09:12");
    expect(metaLine("thread (3)", "")).toBe("thread (3)");
    expect(metaLine("Ohbox", null, "from the archive")).toBe("Ohbox · from the archive");
    expect(metaLine(undefined, null, "")).toBe("");
    // Shape, not spelling: no output may begin or end with the separator, ever.
    for (const out of [metaLine("Ohbox", ""), metaLine("", "09:12"), metaLine("a", null, "b")]) {
      expect(out).not.toMatch(/^\s*·/);
      expect(out).not.toMatch(/·\s*$/);
    }
  });

  it("the open message's header does not introduce a stamp it does not have", async () => {
    const open = msg({ id: "open", subject: "No date on this one", threadId: "t1" });
    const sibling = msg({ id: "sib", subject: "No date on this one", threadId: "t1" });

    // Three in the thread, so the column draws the conversation.
    mountReader({ letters: [open, sibling, msg({ id: "sib2", threadId: "t1" })], open: "open" });

    // The focused message wears its own header; an undated one leaves the stamp slot empty
    // rather than dangling a separator.
    const head = letterOf("open");
    expect(head, "the premise: the focused message rendered its header").not.toBeNull();
    expect(within(head!).getByRole("button", { name: "Message" }), "the premise: its head stands").toBeTruthy();
    for (const stamp of head!.querySelectorAll("time"))
      expect(stamp.textContent ?? "", "a separator with nothing after it").not.toMatch(/·\s*$/);
    // The header no longer carries "thread (N)" — and the count line is gone with the
    // panel redesign, which forbids restating the thread as a number anywhere.
    expect(document.body.textContent).not.toMatch(/thread \(\d+\)/);
    expect(document.body.textContent).not.toContain("on this conversation");
  });

  it("a thread sibling's panel with no stamp renders no stamp element at all", async () => {
    // A panel's header guards its stamp; a dateless one leaves no empty `time`. Red by
    // rendering the stamp unconditionally.
    mountReader({ letters: [msg({ id: "s1", threadId: "t1" }), msg({ id: "focus", threadId: "t1" })], open: "focus" });

    expect(screen.getAllByRole("article").length, "the premise: the panels rendered").toBe(2);
    expect(letterOf("s1")!.querySelectorAll("time").length).toBe(0);
  });

  it("and a DATED sibling's panel still renders one — the guard did not just delete the slot", async () => {
    mountReader({
      letters: [msg({ id: "s1", threadId: "t1", date: "2026-08-04T09:12:00.000Z" }), msg({ id: "focus", threadId: "t1" })],
      open: "focus",
    });

    expect(letterOf("s1")!.querySelectorAll("time").length).toBe(1);
    expect(letterOf("s1")!.querySelector("time")!.textContent).toBe("09:12");
  });
});

/** One letter of the column, by the id it carries. */
function letterOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-conv-id="${id}"]`);
}
