/** @vitest-environment jsdom */
/**
 * A SETTLED SEND KEY IS SPENT (REVIEW-02515 LOW-3).
 * A record is owed per KEY: a late answer waiting for another send must not keep this one's
 * record, and a record whose key the engine reports settled is never handed to a new press —
 * an identical second reply then goes out under a new key and the SERVER decides. Only an
 * unverified record keeps resuming: it is the one evidence a message may already be out.
 */
/* @reads: packages/app-logic/src/writing/mail-send.ts */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  releaseSendLock, resumeSendLock, sendIdentity, sendLocksKey, SEND_LOCK_FORMAT, type SendLock,
} from "@ohmail/app-logic/writing/send-lock";
import { sendLockOwed } from "@ohmail/app-logic/writing/mail-send";

const NOW = Date.now();
const REPLY = { kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", to: [{ name: "Ada", address: "ada@fake.test" }], mailboxId: "mb-1" };
const ID = sendIdentity(REPLY as never, null);
const rec = (o: Partial<SendLock> & { key: string }): SendLock => ({
  v: SEND_LOCK_FORMAT, lane: "m-1", at: NOW, draftId: null, fp: ID.fp, subject: "reply:m-1", ...o,
});
const put = (rows: SendLock[]): void => window.localStorage.setItem(sendLocksKey(null), JSON.stringify(rows));
const keys = (): string[] => (JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as SendLock[]).map((r) => r.key).sort();

/**
 * The engine as the hook reads it: its outbox restored and nothing standing, so every key is
 * settled — and one late answer for ANOTHER send (`K-other`) waiting to be collected.
 */
function engine(o: { known?: boolean; late?: string[] } = {}) {
  const late = o.late ?? ["K-other"];
  return {
    outboxKnown: () => o.known ?? true,
    read: () => ({ list: () => [], get: () => undefined }),
    pendingMutations: () => [],
    inFlightMutations: () => [],
    hasLateResults: () => late.length > 0,
    lateResultKeys: () => new Set(late),
  } as never;
}

beforeEach(() => { window.localStorage.clear(); });

describe("a send record is owed per key, and a settled key is spent", () => {
  it("LOW-3 a reply confirmed while another send's late answer waits: its record goes with the confirm", () => {
    put([rec({ key: "K-a" })]);
    releaseSendLock("m-1", ID.fp, sendLockOwed(engine()), null);
    expect(keys(), "the late answer of K-other kept K-a's record").toEqual([]);
  });

  it("LOW-3 an identical second reply is a new key: the settled record is not resumed, and it is spent", () => {
    put([rec({ key: "K-a" })]);
    const resumed = resumeSendLock("m-1", ID, NOW, sendLockOwed(engine({ late: [] })), null);
    expect({ resumed, jar: keys() }).toEqual({ resumed: null, jar: [] });
  });

  it("a late answer for THIS key keeps its record and resumes it (its ending can still reach the surface)", () => {
    put([rec({ key: "K-a" })]);
    const owed = sendLockOwed(engine({ late: ["K-a"] }));
    releaseSendLock("m-1", ID.fp, owed, null);
    expect({ resumed: resumeSendLock("m-1", ID, NOW, owed, null), jar: keys() }).toEqual({ resumed: "K-a", jar: ["K-a"] });
  });

  it("an unverified record keeps resuming though its key is settled: it is the evidence a message may be out", () => {
    put([rec({ key: "K-u", unverified: true })]);
    const resumed = resumeSendLock("m-1", ID, NOW, sendLockOwed(engine({ late: [] })), null);
    expect({ resumed, jar: keys() }).toEqual({ resumed: "K-u", jar: ["K-u"] });
  });

  it("before the outbox is known nothing is settled: the record resumes and stays", () => {
    put([rec({ key: "K-a" })]);
    const resumed = resumeSendLock("m-1", ID, NOW, sendLockOwed(engine({ known: false, late: [] })), null);
    expect({ resumed, jar: keys() }).toEqual({ resumed: "K-a", jar: ["K-a"] });
  });
});

describe("Cancel's sentence is the server's", () => {
  const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");
  it("both docks say the unreachable Cancel in the one new sentence, in both catalogues", () => {
    const shell = read("../../packages/app-logic/src/writing/shell-compose.ts");
    const en = JSON.parse(read("messages/en.json")) as { compose: Record<string, string> };
    const de = JSON.parse(read("messages/de.json")) as { compose: Record<string, string> };
    expect({
      sites: (shell.match(/said === "unreachable"\) \{\s*toast\(t\("compose\.cancelUnreachable"\)\);\s*return;/g) ?? []).length,
      en: en.compose.cancelUnreachable, de: typeof de.compose.cancelUnreachable,
      onTheWire: en.compose.cancelAlreadySent,
    }).toEqual({
      sites: 2,
      en: "Couldn't reach the server to cancel. ohmail will keep asking and will not send this again.",
      de: "string", onTheWire: "Already on its way. Too late to cancel.",
    });
  });
});

