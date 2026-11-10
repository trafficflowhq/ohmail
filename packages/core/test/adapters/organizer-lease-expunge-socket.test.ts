import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  ClaimReleaseError, LeaseUnavailableError, MetaRoomRefusedError, claimRefusedForRoom, makeLeaseIo, type LeaseImapClient,
} from "../../src/adapters/organizer-lease.js";

/**
 * A SOCKET THAT DIES DURING EXPUNGE IS A TRANSPORT FAULT, NOT A REFUSAL (a low review
 * finding). imapflow's `messageDelete` resolves `false` both when the server refuses the EXPUNGE and
 * when the connection drops under it; only the refusal may count toward the undeletable block. A
 * loopback stub speaks just enough IMAP for the real client, then destroys the socket on
 * `UID EXPUNGE` — or, as the control, answers it `NO`.
 */

const META = "ohmail/_meta";
const ID = { installId: "us", mailboxId: "mb-socket" };

interface StubAnswers {
  onExpunge?: "destroy" | "refuse";
  /** The tagged answer to APPEND, after its literal; `destroy` drops the socket instead. */
  append?: string;
  /** The `* QUOTA` resources GETQUOTAROOT answers; null is a server without QUOTA. */
  quota?: string | null;
}

function stub(answers: StubAnswers, seen: string[] = []): Promise<{ server: Server; port: number }> {
  const caps = `IMAP4rev1 UIDPLUS${answers.quota == null ? "" : " QUOTA"} AUTH=PLAIN`;
  const server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let literal = 0;
    let appendTag: string | null = null;
    const say = (line: string): void => { if (!sock.destroyed) sock.write(`${line}\r\n`); };
    say(`* OK [CAPABILITY ${caps}] stub ready`);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (literal > 0) {
          if (buf.length < literal + 2) return;
          buf = buf.subarray(literal + 2);
          literal = 0;
          if (answers.append === "destroy") { sock.destroy(); return; }
          say(`${appendTag} ${answers.append ?? "OK [APPENDUID 7 2] done"}`);
          continue;
        }
        const at = buf.indexOf("\r\n");
        if (at < 0) return;
        const line = buf.subarray(0, at).toString("utf8");
        buf = buf.subarray(at + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ").toUpperCase();
        seen.push(cmd.split(" ")[0]!);
        if (cmd.startsWith("CAPABILITY")) { say(`* CAPABILITY ${caps}`); say(`${tag} OK done`); }
        else if (cmd.startsWith("APPEND")) {
          literal = Number(/\{(\d+)\+?\}$/.exec(line)?.[1] ?? 0);
          appendTag = tag!;
          say("+ go ahead");
        } else if (cmd.startsWith("GETQUOTAROOT")) {
          say(`* QUOTAROOT "${META}" ""`); say(`* QUOTA "" (${answers.quota})`); say(`${tag} OK done`);
        }
        else if (cmd === 'LIST "" ""') { say('* LIST (\\Noselect) "/" ""'); say(`${tag} OK done`); }
        else if (cmd.startsWith("LIST")) { say(`* LIST (\\HasNoChildren \\Subscribed) "/" "${META}"`); say(`${tag} OK done`); }
        else if (cmd.startsWith("SELECT") || cmd.startsWith("EXAMINE")) {
          say("* 1 EXISTS"); say("* OK [UIDVALIDITY 7] ok"); say("* OK [UIDNEXT 2] ok");
          say("* FLAGS (\\Seen \\Deleted)"); say("* OK [PERMANENTFLAGS (\\Seen \\Deleted)] ok");
          say(`${tag} OK [READ-WRITE] selected`);
        } else if (cmd.startsWith("UID FETCH")) { say("* 1 FETCH (UID 1)"); say(`${tag} OK done`); }
        else if (cmd.startsWith("UID STORE")) { say(`${tag} OK done`); }
        else if (cmd.startsWith("UID EXPUNGE")) {
          if (answers.onExpunge === "destroy") sock.destroy();
          else say(`${tag} NO [NOPERM] expunge not permitted`);
        } else if (cmd.startsWith("LOGOUT")) { say("* BYE"); say(`${tag} OK bye`); sock.end(); }
        else say(`${tag} OK done`);
      }
    });
    sock.on("error", () => { /* the stub's own destroy */ });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr !== null ? addr.port : 0 });
    });
  });
}

let open: Array<() => Promise<void>> = [];
beforeEach(() => { resetMetaMemos(); });
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => undefined); });

async function connected(answers: StubAnswers | "destroy" | "refuse", seen?: string[]): Promise<ImapFlow> {
  const { server, port } = await stub(typeof answers === "string" ? { onExpunge: answers } : answers, seen);
  const client = new ImapFlow({
    host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" }, logger: false,
  });
  client.on("error", () => { /* the drop is the subject */ });
  await client.connect();
  open.push(async () => { client.close(); await new Promise<void>((r) => { server.close(() => r()); }); });
  return client;
}

const io = (c: ImapFlow) => makeLeaseIo(c as unknown as LeaseImapClient, (x) => x, ID);

describe("a dead socket under EXPUNGE is not the server refusing", () => {
  it("removeClaims throws a transport fault, not expunge_refused", async () => {
    const c = await connected("destroy");
    const err = await io(c).removeClaims([1]).then(() => null, (e: unknown) => e);
    expect(err instanceof ClaimReleaseError, "a dropped socket was counted as a refusal").toBe(false);
    expect(err instanceof LeaseUnavailableError && err.op).toBe("remove_claims");
  });

  it("the probe reads unproven, not standing", async () => {
    const c = await connected("destroy");
    const lease = io(c);
    lease.noteCleanup!({ landed: false, uid: 1, generation: 7 });
    expect(await lease.probeUndeletable!()).toEqual({ kind: "unproven" });
  });

  it("CONTROL: a refused EXPUNGE on a live socket is still expunge_refused, in both", async () => {
    const c = await connected("refuse");
    const err = await io(c).removeClaims([1]).then(() => null, (e: unknown) => e);
    expect(err instanceof ClaimReleaseError && err.code).toBe("expunge_refused");
    const lease = io(c);
    lease.noteCleanup!({ landed: false, uid: 1, generation: 7 });
    expect(await lease.probeUndeletable!()).toEqual({ kind: "standing", uid: 1, code: "expunge_refused" });
  });
});

/* A CLAIM REFUSED FOR ROOM (a mailbox at its own quota): Dovecot's OVERQUOTA names it by
   structure; a bare NO is named only by a quota reading the claim cannot fit. Every other refusal
   keeps its own error. Over a real ImapFlow, so the shapes are the library's. */
describe("a claim APPEND refused for room", () => {
  const FULL = "STORAGE 6144 6144";
  const refusal = async (answers: StubAnswers) => {
    const seen: string[] = [];
    const c = await connected(answers, seen);
    const err = await io(c).appendClaim("X-Ohmail-Lease: 1\r\nSubject: ohmail lease\r\n\r\nx\r\n").then(() => null, (e: unknown) => e);
    return { err, room: claimRefusedForRoom(err), quotaAsked: seen.filter((v) => v === "GETQUOTAROOT").length };
  };

  it("Dovecot's OVERQUOTA is a room refusal, with no GETQUOTAROOT sent", async () => {
    const r = await refusal({ append: "NO [OVERQUOTA] Quota exceeded (mailbox for user is full)", quota: FULL });
    expect([r.room, r.quotaAsked]).toEqual([true, 0]);
  });

  it("a bare NO with QUOTA reading the mailbox full is a room refusal", async () => {
    const r = await refusal({ append: "NO APPEND failed", quota: FULL });
    expect(r.err).toBeInstanceOf(MetaRoomRefusedError);
    expect([r.room, r.quotaAsked]).toEqual([true, 1]);
  });

  it.each([
    ["a bare NO with room left", { append: "NO APPEND failed", quota: "STORAGE 6000 6144" }, 1],
    ["a bare NO without QUOTA", { append: "NO APPEND failed", quota: null }, 0],
    ["NO [LIMIT] without QUOTA", { append: "NO [LIMIT] too many", quota: null }, 0],
    ["a dropped socket", { append: "destroy", quota: FULL }, 0],
  ] as const)("CONTROL: %s keeps the original error", async (_label, answers, asked) => {
    const r = await refusal(answers);
    expect(r.err, "the append was not refused at all").not.toBeNull();
    expect(r.err).not.toBeInstanceOf(MetaRoomRefusedError);
    expect([r.room, r.quotaAsked]).toEqual([false, asked]);
  });
});
