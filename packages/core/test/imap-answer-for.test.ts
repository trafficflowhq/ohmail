import { describe, expect, it } from "vitest";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import * as imap from "../src/adapters/imap.js";

const { answerFor, answerForTheAskedMessage } = imap;

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

describe("readServerDates — INTERNALDATE as an instant, whatever the runtime's Date parses", () => {
  // Spelled out so the case is red on a build without the export, not a load error.
  const readServerDates = (c: ImapFlow): void => (imap as { readServerDates?: (c: ImapFlow) => void }).readServerDates!(c);
  const imapDateTime = (v: unknown): Date | null => (imap as { imapDateTime?: (v: unknown) => Date | null }).imapDateTime!(v);
  const at = (m: unknown): unknown => {
    const d = (m as { internalDate?: unknown }).internalDate;
    return d instanceof Date ? d.getTime() : d;
  };

  it("turns a string stamp into the server's instant on fetch and fetchOne", async () => {
    const kept = new Date(Date.UTC(2026, 0, 1));
    const rows: unknown[] = [
      { uid: 1, internalDate: " 4-Oct-2026 08:29:08 +0200" },
      { uid: 2, internalDate: "24-oct-2026 06:29:09 -0130" },
      { uid: 3, internalDate: kept },
      { uid: 4, internalDate: "Thursday" },
      { uid: 5 },
    ];
    const client = {
      async *fetch() { for (const r of rows) yield r; },
      async fetchOne(seq: string) { return seq === "9" ? false : { uid: 1, internalDate: "01-Jan-2026 00:00:00 +0000" }; },
    } as unknown as ImapFlow;
    readServerDates(client);
    const got: unknown[] = [];
    for await (const m of client.fetch("1:*", { internalDate: true })) got.push(m);
    expect(got.map(at)).toEqual([
      Date.UTC(2026, 9, 4, 6, 29, 8), Date.UTC(2026, 9, 24, 7, 59, 9), kept.getTime(), "Thursday", undefined,
    ]);
    expect((got[2] as { internalDate: Date }).internalDate).toBe(kept);
    expect(at(await client.fetchOne("1", { internalDate: true }))).toBe(Date.UTC(2026, 0, 1));
    expect(await client.fetchOne("9", { internalDate: true })).toBe(false);
  });

  it("reads only the RFC 3501 form, never through the runtime's parser", () => {
    expect(imapDateTime("31-Feb-2026 00:00:00 +0000")).toBeNull();
    expect(imapDateTime("2026-10-24T06:29:09Z")).toBeNull();
    expect(imapDateTime("24-Foo-2026 06:29:09 +0000")).toBeNull();
    expect(imapDateTime("24-Oct-2026 24:00:00 +0000")).toBeNull();
    expect(imapDateTime(new Date(Number.NaN))).toBeNull();
    expect(imapDateTime(12)).toBeNull();
  });
});
