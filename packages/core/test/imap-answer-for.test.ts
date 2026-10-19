import { describe, expect, it } from "vitest";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { answerFor, answerForTheAskedMessage } from "../src/adapters/imap.js";

/**
 * WHICH UNTAGGED FETCH IS `fetchOne`'S ANSWER — the rule `answerForTheAskedMessage` puts on every
 * connection, pinned without a server. The race it closes is driven end to end against GreenMail and
 * Dovecot in `adapters/imap.part-flag-race.test.ts`; this file holds the choices one at a time.
 */

const chunk = Buffer.from("the second 64 KiB of the pdf");
const reply = (uid: number, seq = 7): FetchMessageObject =>
  ({ seq, uid, bodyParts: new Map([["2", chunk]]) }) as FetchMessageObject;
const flagUpdate = (uid: number | undefined, seq = 7): FetchMessageObject =>
  ({ seq, ...(uid === undefined ? {} : { uid }), flags: new Set(["\\Seen"]), modseq: 42n }) as FetchMessageObject;
const CHUNK_QUERY = { bodyParts: [{ key: "2", start: 65536, maxLength: 65536 }] };

describe("answerFor — the asked message's own answers, merged", () => {
  it("a flag update for the asked message AHEAD of the reply: the reply's data, the update's flags", () => {
    const got = answerFor([flagUpdate(42), reply(42)], "42", CHUNK_QUERY, true);
    expect(got && got.bodyParts?.get("2")).toEqual(chunk);
    expect(got && [...(got.flags ?? [])]).toEqual(["\\Seen"]);
  });

  it("a flag update with no UID (a server without QRESYNC) is not the asked message's answer by UID", () => {
    const got = answerFor([flagUpdate(undefined), reply(42)], "42", CHUNK_QUERY, true);
    expect(got && got.bodyParts?.get("2")).toEqual(chunk);
  });

  it("another message's update first is never the answer", () => {
    const got = answerFor([flagUpdate(43, 8), reply(42)], 42, CHUNK_QUERY, true);
    expect(got && got.uid).toBe(42);
    expect(got && got.bodyParts?.get("2")).toEqual(chunk);
    expect(got && got.flags).toBeUndefined();
  });

  it("only another message's update arrived: no answer, as imapflow says 'no such message'", () => {
    expect(answerFor([flagUpdate(43, 8)], "42", CHUNK_QUERY, true)).toBe(false);
  });

  it("a sequence-number fetch matches on the sequence number", () => {
    const got = answerFor([flagUpdate(43, 8), reply(42, 7)], "7", CHUNK_QUERY, false);
    expect(got && got.uid).toBe(42);
  });

  it("a range or * keeps imapflow's own choice, the first answer", () => {
    const first = flagUpdate(43, 8);
    expect(answerFor([first, reply(42)], "1:*", CHUNK_QUERY, true)).toBe(first);
    expect(answerFor([first, reply(42)], "*", CHUNK_QUERY, false)).toBe(first);
  });

  it("a reply split in two answers is joined: maps and sets are unions in which the reply wins", () => {
    const mime = { seq: 7, uid: 42, bodyParts: new Map([["2.mime", Buffer.from("Content-Type: application/pdf")]]) } as FetchMessageObject;
    const body = {
      seq: 7, uid: 42, size: 368015,
      bodyParts: new Map([["2", chunk], ["2.mime", Buffer.from("the reply's own")]]),
      binaryParts: new Set(["2"]),
    } as FetchMessageObject;
    const query = { size: true, bodyParts: ["2.mime", { key: "2", start: 0, maxLength: 65536 }] };
    const got = answerFor([mime, body], "42", query, true);
    expect(got && [...(got.bodyParts?.keys() ?? [])].sort()).toEqual(["2", "2.mime"]);
    expect(got && got.bodyParts?.get("2.mime")?.toString()).toBe("the reply's own");
    expect(got && got.size).toBe(368015);
    expect(got && [...(got.binaryParts ?? [])]).toEqual(["2"]);
  });

  it("an existence read ({ uid }) is answered by any answer of that message", () => {
    expect(answerFor([flagUpdate(42)], "42", { uid: true }, true)).toMatchObject({ uid: 42 });
    expect(answerFor([flagUpdate(43, 8)], "42", { uid: true }, true)).toBe(false);
  });

  it("an existence read is never answered by an update that names no UID: a gone message stays gone", () => {
    // The cut-read witness in `streamPart` and the move's survivor check ask exactly this; an update
    // about some other message (Dovecot without QRESYNC sends them with no UID) must not read as present.
    expect(answerFor([flagUpdate(undefined, 3)], "42", { uid: true }, true)).toBe(false);
  });

  it("a server that leaves the UID out of its reply: the nameless answer carrying the asked content", () => {
    const nameless = { seq: 7, bodyParts: new Map([["2", chunk]]) } as unknown as FetchMessageObject;
    expect(answerFor([flagUpdate(undefined), nameless], "42", CHUNK_QUERY, true)).toBe(nameless);
    // A nameless flag update alone carries no content: no answer.
    expect(answerFor([flagUpdate(undefined)], "42", CHUNK_QUERY, true)).toBe(false);
  });
});

describe("answerForTheAskedMessage — the connection's fetchOne", () => {
  it("collects the command's answers and answers with the asked message's", async () => {
    const asked: Array<Record<string, unknown> | undefined> = [];
    const client = {
      async fetchOne(_seq: unknown, _query: unknown, options?: Record<string, unknown>) {
        asked.push(options);
        const stream = options?.onUntaggedFetch as ((m: FetchMessageObject, done: (e?: Error) => void) => void) | undefined;
        // What imapflow's fetch command does with `onUntaggedFetch`: every answer to it, list empty.
        for (const m of [flagUpdate(42), reply(42)]) await new Promise<void>((r) => stream!(m, () => r()));
        return false;
      },
    } as unknown as ImapFlow;
    answerForTheAskedMessage(client);
    const got = await client.fetchOne("42", CHUNK_QUERY, { uid: true });
    expect(got && got.bodyParts?.get("2")).toEqual(chunk);
    // The caller's own options still reach the FETCH.
    expect(asked[0]).toMatchObject({ uid: true });
  });

  it("a driver that streams nothing keeps its own answer", async () => {
    const own = reply(42);
    const client = { fetchOne: async () => own } as unknown as ImapFlow;
    answerForTheAskedMessage(client);
    expect(await client.fetchOne("42", CHUNK_QUERY, { uid: true })).toBe(own);
  });

  it("a stand-in client without fetchOne is left alone", () => {
    const client = {} as ImapFlow;
    answerForTheAskedMessage(client);
    expect((client as { fetchOne?: unknown }).fetchOne).toBeUndefined();
  });
});
