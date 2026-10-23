import { describe, expect, it } from "vitest";
import { mayHandOff, type HandOffInputs } from "../app/shell/send-handoff";
import type { MailboxFacts } from "../app/shell/mail-state";
import type { SendLineItem } from "../app/shell/mail-send";
import { lineRows } from "../app/shell/SendingLine";

/**
 * THE HAND-OFF GATE'S TRUTH TABLE. A send leaves its editor at once only when the connection is
 * healthy in every way the shell can read at the press; each arm alone keeps the editor open.
 */

const MAILBOX = {
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-10-23T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
} as unknown as MailboxFacts;

const HEALTHY: HandOffInputs = {
  stateKey: "quiet",
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false, standingDown: false },
  online: true, outboxHeld: false, hostOffline: false, mailbox: MAILBOX, scheduled: false,
};

describe("mayHandOff", () => {
  it("is true when everything is healthy, and while filing or importing", () => {
    expect(mayHandOff(HEALTHY)).toBe(true);
    expect(mayHandOff({ ...HEALTHY, stateKey: "filing" })).toBe(true);
    expect(mayHandOff({ ...HEALTHY, stateKey: "importing" })).toBe(true);
  });

  const arms: Array<[string, Partial<HandOffInputs>]> = [
    ["send later", { scheduled: true }],
    ["offline", { online: false }],
    ["the outbox held", { outboxHeld: true }],
    ["a paired host offline", { hostOffline: true }],
    ["Can't refresh (failing)", { stateKey: "failing" }],
    ["stale", { stateKey: "stale" }],
    ["catching up", { stateKey: "catchingUp" }],
    ["stopped", { stateKey: "stopped" }],
    ["owner lost", { stateKey: "ownerLost" }],
    ["blocked", { stateKey: "blocked" }],
    ["a mailbox error", { stateKey: "mailboxError" }],
    ["awaiting a first sync", { stateKey: "awaiting" }],
    ["no mailbox", { stateKey: "noMailbox" }],
    ["bootstrapping", { sync: { ...HEALTHY.sync, bootstrapping: true } }],
    ["a failed drain", { sync: { ...HEALTHY.sync, failures: 1 } }],
    ["terminal", { sync: { ...HEALTHY.sync, terminal: true } }],
    ["refused", { sync: { ...HEALTHY.sync, refused: true } }],
    ["sync owner lost", { sync: { ...HEALTHY.sync, ownerLost: true } }],
    ["standing down", { sync: { ...HEALTHY.sync, standingDown: true } }],
    ["the mailbox unknown", { mailbox: null }],
    ["the mailbox not connected", { mailbox: { ...MAILBOX, status: "error" } }],
    ["the mailbox with an error", { mailbox: { ...MAILBOX, errorCode: "auth" } }],
    ["the mail server unreachable", { mailbox: { ...MAILBOX, unreachableSince: "2026-10-23T08:58:00.000Z" } }],
  ];
  for (const [what, arm] of arms) {
    it(`is false for ${what} alone`, () => {
      expect(mayHandOff({ ...HEALTHY, ...arm })).toBe(false);
    });
  }
});

describe("the foot line's rows (lineRows)", () => {
  const item = (key: string, state: SendLineItem["state"], over: Partial<SendLineItem> = {}): SendLineItem =>
    ({ id: `${key}#1`, key, state, to: null, subject: null, ...over });
  const kept = (key: string): SendLineItem => item(key, "ended", { ended: { phase: "failed", code: "send_unreachable" }, left: { rowId: `row-${key}`, aboutThisCompose: false } });
  const shape = (items: SendLineItem[]) => lineRows(items).map((r) => ({ kind: r.kind, keys: r.items.map((i) => i.key) }));

  it("every kind present stands on its own row, the endings first: none hides another; several kept are counted", () => {
    expect(shape([item("a", "sent"), item("b", "sending"), item("c", "queued"), kept("d"), kept("e")])).toEqual([
      { kind: "ended", keys: ["d", "e"] },
      { kind: "queued", keys: ["c"] },
      { kind: "sending", keys: ["b"] },
      { kind: "sent", keys: ["a"] },
    ]);
    expect(shape([item("a", "sent"), item("b", "sending")])).toEqual([{ kind: "sending", keys: ["b"] }, { kind: "sent", keys: ["a"] }]);
    expect(lineRows([])).toEqual([]);
  });

  it("an unverified ending is never counted as not sent: it says its own line, above the count", () => {
    expect(shape([kept("d"), item("u", "ended", { ended: { phase: "unverified" } }), kept("e")])).toEqual([
      { kind: "ended", keys: ["u"] },
      { kind: "ended", keys: ["d", "e"] },
    ]);
  });
});
