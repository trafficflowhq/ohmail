import { describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { countPlainVanished, imapFlowOptions } from "../src/adapters/imap.js";

/**
 * A plain VANISHED lowers the open mailbox's count (RFC 7162 §3.2.10). imapflow 1.7.8 lowers it only
 * for EXPUNGE, so on a QRESYNC server (Dovecot) the next arrival's EXISTS equalled the stale count,
 * imapflow dropped it and the INBOX doorbell never rang. A real, never-connected client, its untagged
 * handlers driven directly: no server, so this file stays out of the Dovecot shard.
 */

interface Handlers {
  untaggedVanished(u: unknown, mailbox?: unknown): Promise<void>;
  untaggedExists(u: unknown): Promise<void>;
  untaggedExpunge(u: unknown): Promise<void>;
}

function unconnected(exists: number): { client: ImapFlow; wire: Handlers; count: () => number } {
  const client = new ImapFlow(imapFlowOptions({
    host: "127.0.0.1", port: 143, secure: false, allowInsecure: true, auth: { user: "u", pass: "p" },
  } as Parameters<typeof imapFlowOptions>[0]));
  (client as unknown as { mailbox: unknown }).mailbox = { path: "INBOX", exists };
  const count = (): number => {
    const mb = client.mailbox;
    return mb ? mb.exists : -1;
  };
  return { client, wire: client as unknown as Handlers, count };
}

const plain = (uids: string) => ({ attributes: [{ type: "ATOM", value: uids }] });
const earlier = (uids: string) => ({ attributes: [[{ type: "ATOM", value: "EARLIER" }], { type: "ATOM", value: uids }] });
const existsLine = (n: number) => ({ command: String(n), attributes: [] });

describe("a plain VANISHED and the open mailbox's count", () => {
  it("imapflow does not count a plain VANISHED itself: remove countPlainVanished when this fails", async () => {
    const { wire, count } = unconnected(5);
    await wire.untaggedVanished(plain("1:3"));
    expect(count()).toBe(5);
  });

  it("without the count, the next arrival's EXISTS emits nothing (the defect)", async () => {
    const { client, wire } = unconnected(1);
    const rang: number[] = [];
    client.on("exists", (e: { count: number }) => rang.push(e.count));
    await wire.untaggedVanished(plain("7"));
    await wire.untaggedExists(existsLine(1));
    expect(rang).toEqual([]);
  });

  it("counts one per UID, not EARLIER or the SELECT stand-in, rings the next arrival once, never below 0", async () => {
    const { client, wire, count } = unconnected(5);
    expect(countPlainVanished(client)).toBe(true);
    const rang: number[] = [];
    client.on("exists", (e: { count: number }) => rang.push(e.count));
    await wire.untaggedVanished(plain("1:3"));
    expect(count()).toBe(2);
    await wire.untaggedVanished(earlier("10:20"));
    expect(count()).toBe(2);
    await wire.untaggedVanished(earlier("4"), { path: "INBOX", uidNext: false, uidValidity: false });
    expect(count()).toBe(2);
    await wire.untaggedExists(existsLine(3));
    expect(rang).toEqual([3]);
    await wire.untaggedVanished(plain("4:9"));
    expect(count()).toBe(0);
  });

  it("a plain EXPUNGE is counted once, by imapflow", async () => {
    const { client, wire, count } = unconnected(5);
    countPlainVanished(client);
    await wire.untaggedExpunge({ command: "2", attributes: [] });
    expect(count()).toBe(4);
  });

  it("a stand-in without an event surface is left alone", () => {
    expect(countPlainVanished({})).toBe(false);
  });
});
