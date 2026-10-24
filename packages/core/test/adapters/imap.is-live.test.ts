import { describe, expect, it } from "vitest";
import { ImapAdapter, IMAP_READ_DEADLINE_MS, ImapBoundExceeded, type ImapConfig } from "../../src/adapters/imap.js";
import { SentCopyAppendFailed } from "../../src/send.js";

/**
 * `ImapAdapter.isLive()` — the send door's admission for reusing a connection. It reads
 * imapflow's own `usable`, cleared the moment the socket closes or ends; a retired or closing
 * adapter reads dead too. And the Sent APPEND waits under the read deadline like every other
 * server command: a spent deadline refuses the wait and retires the connection, so the keeper
 * reads it dead instead of handing a hang to the next press.
 * THE MUTATIONS THAT MAKE THIS RED: `isLive()` returning `this.established` alone → (2) admits
 * a dead socket; the APPEND back to a raw `this.client.append(...)` → (4) SUCCEEDS where a
 * refusal is owed. Watched fail and restored.
 */

const cfg: ImapConfig = {
  host: "imap.example.test", port: 993, secure: true,
  auth: { user: "u@example.test", pass: "p" },
  smtp: { host: "smtp.example.test", port: 587, secure: false },
};

/** A minimal injected client: connected, LIST answers a Sent folder, APPEND answers and counts. */
function fakeClient() {
  const client = {
    usable: true,
    appends: 0,
    capabilities: new Map<string, boolean>(),
    namespaces: undefined,
    async list() {
      return [
        { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() },
        { path: "Sent", name: "Sent", delimiter: "/", flags: new Set<string>(), specialUse: "\\Sent" },
      ];
    },
    async append(): Promise<unknown> {
      client.appends += 1;
      return { uid: 7, uidValidity: 1n };
    },
    /** A SELECT: the Sent folder answers while the socket is up; anything else is not there. */
    async getMailboxLock(path: string) {
      if (!client.usable) throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
      if (path !== "Sent") throw Object.assign(new Error("Mailbox doesn't exist"), { responseStatus: "NO" });
      return { path, release() { /* nothing held */ } };
    },
    async search(): Promise<number[]> { return []; },
    async logout() { client.usable = false; },
    close() { client.usable = false; },
    async noop() { /* fine */ },
  };
  return client;
}

async function connected(nowMs?: () => number) {
  const client = fakeClient();
  const adapter = new ImapAdapter(cfg, { client, ...(nowMs ? { nowMs } : {}) });
  await adapter.connect();
  return { adapter, client };
}

describe("ImapAdapter.isLive — the reuse admission", () => {
  it("(1) reads true on a connected adapter (the positive control)", async () => {
    const { adapter } = await connected();
    expect(adapter.isLive()).toBe(true);
  });

  it("(2) reads false the moment the driver clears `usable` — the socket closed under it", async () => {
    const { adapter, client } = await connected();
    client.usable = false;
    expect(adapter.isLive()).toBe(false);
  });

  it("(3) reads false after close() and after forceClose()", async () => {
    const a = await connected();
    await a.adapter.close();
    expect(a.adapter.isLive()).toBe(false);
    const b = await connected();
    b.adapter.forceClose();
    expect(b.adapter.isLive()).toBe(false);
  });

  it("(4) the Sent APPEND waits under the read deadline: a spent clock refuses the wait and retires the connection", async () => {
    /* The clock stands still through connect(), then JUMPS past the deadline between the
       deadline's creation and its first reading inside `bounded()` — the shape of a server that
       took the whole budget. Every read in this class shares that door; this arm pins that the
       APPEND does too. */
    let jumping = false;
    let calls = 0;
    const nowMs = (): number => (jumping ? (calls += 1) * (IMAP_READ_DEADLINE_MS + 1) : 0);
    const { adapter, client } = await connected(nowMs);
    // The SMTP half is not the subject: a transporter that delivers at once.
    (adapter as unknown as { transporter: unknown }).transporter = {
      sendMail: async () => ({ messageId: "<m@x>" }), close() { /* nothing */ },
    };
    jumping = true;
    const outcome = await adapter
      .send({ from: "u@example.test", to: "b@x.test", subject: "s", text: "t" })
      .then(() => "resolved", (e: unknown) => e);
    /* The message has left by then, so the breach reaches the send as a missing Sent copy
       (`SentCopyAppendFailed`, the send finalizes `sent`) carrying the bound as its cause. */
    expect(outcome).toBeInstanceOf(SentCopyAppendFailed);
    const cause = (outcome as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(ImapBoundExceeded);
    expect((cause as ImapBoundExceeded).bound).toBe("read_deadline");
    // The command was issued — `bounded` bounds the WAIT, as it does for every LIST and SEARCH
    // in the class — and the wait was refused rather than held past the deadline.
    expect(client.appends).toBe(1);
    expect(client.usable).toBe(false);          // the socket was destroyed, not left to a queue
    expect(adapter.isLive()).toBe(false);       // and the keeper reads it dead
  });

  it("(5) messageInSent on a connection that died throws; it never answers \"not in Sent\"", async () => {
    const { adapter, client } = await connected();
    expect(await adapter.messageInSent("<m@x.test>"), "the control: a live, empty Sent").toBe(false);
    // The socket timed out while the slow SMTP leg ran: imapflow clears `usable`.
    client.usable = false;
    const outcome = await adapter.messageInSent("<m@x.test>").then((v) => v, (e: unknown) => e);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as { code?: string }).code).toBe("NoConnection");
  });
});
