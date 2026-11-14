
/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import {
  accounts, folderState, mailboxes, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { eq } from "drizzle-orm";
import { runSensitiveRescreen } from "../src/sensitive-rescreen.js";
import type { Db } from "../src/context.js";

/**
 * INVARIANT 3, AS A TEST THAT CAN FAIL: **the re-screen pass never opens IMAP.**
 *
 * The IMAP mailbox is the master (the "Organize-in-place" invariant, CLAUDE.md). Re-routing means writing
 * `folder_state.desired_folder` and letting the always-on worker apply it — the one code path
 * that already knows how to do a move crash-safely. A pass that dialled a mail server to file
 * hundreds of messages would be a second organizer racing the reconciler, and it would do it from a
 * process with no lease.
 *
 * Three independent guards, because each catches a different way of breaking it:
 *
 *  1. **The module graph.** `imapflow` is not reachable from `sensitive-rescreen.ts`. This is the
 *     static half and the only one that holds for a code path a test never enters.
 *  2. **The constructor.** `imapflow` is mocked to throw on `new ImapFlow(…)`. If the pass ever
 *     builds a client — directly or through `MailboxAdapter` — the test dies naming it.
 *  3. **The socket.** `net.Socket.prototype.connect` and `tls.connect` are trapped for the length
 *     of the run. This catches a hand-rolled connection that never touches imapflow at all,
 *     including one hidden behind a dependency. Loopback is NOT exempted here (unlike the
 *     suite-wide egress hook), because a local GreenMail on 3143 is exactly the connection this
 *     invariant forbids.
 *
 * PGlite is the right engine for this file and it is not a shortcut: the claim is about what the
 * pass CALLS, not about how Postgres schedules it. The transactional claims live in
 * `sensitive-rescreen.pg.test.ts`, on :5433, where they belong.
 */

vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() {
      throw new Error("IMAP_CLIENT_CONSTRUCTED: the re-screen pass must not open IMAP");
    }
  },
}));

const SRC = fileURLToPath(new URL("../src/sensitive-rescreen.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../src/sensitive-rescreen-cli.ts", import.meta.url));

describe("the re-screen pass opens no IMAP connection", () => {
  it("neither the pass nor its CLI names imapflow or an IMAP adapter", () => {
    // The static half. `@trafficflow/core/adapters/imap` is the only door to `imapflow` in this
    // workspace, so naming either is the whole violation surface.
    for (const [label, file] of [["pass", SRC], ["cli", CLI]] as const) {
      const body = readFileSync(file, "utf8");
      // The prose in these files DISCUSSES IMAP at length, so match the import machinery rather
      // than the word — otherwise the guard would be satisfied by deleting a comment.
      const imports = [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${label} imports ${spec}`).not.toMatch(/imapflow|adapters\/imap|adapters\/organizer-lease/);
      }
    }
  });

  it("a full pass over a real backlog constructs no client and opens no socket", async () => {
    const pglite = await makeTestDb();
    const db = pglite as unknown as Db;
    const tx = pglite as unknown as Tx;

    const accountId = randomUUID();
    await tx.insert(accounts).values({ id: accountId, name: "no-imap" });
    const [mb] = await tx.insert(mailboxes).values({
      accountId, provider: "imap", address: "no-imap@example.test",
    }).returning();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [m] = await tx.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `ni:${randomUUID()}`,
        subject: "Your verification code", fromAddress: `s${i}@stranger.test`,
        sensitivityCategory: "otp", nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      }).returning();
      await tx.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
      await tx.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      ids.push(m!.id);
    }

    const attempts: string[] = [];
    const realSocketConnect = net.Socket.prototype.connect;
    const realTlsConnect = tls.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    net.Socket.prototype.connect = function (...args: any[]): never {
      attempts.push(`net.Socket.connect(${JSON.stringify(args[0])})`);
      throw new Error("SOCKET_OPENED: the re-screen pass must not open a connection");
    } as typeof net.Socket.prototype.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tls as any).connect = (...args: any[]): never => {
      attempts.push(`tls.connect(${JSON.stringify(args[0])})`);
      throw new Error("SOCKET_OPENED: the re-screen pass must not open a connection");
    };

    try {
      const r = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: mb!.id });
      // The pass DID the work — a guard that passes because nothing ran is not a guard.
      expect(r).toMatchObject({ ran: true, examined: 3, rescreened: 3 });
    } finally {
      net.Socket.prototype.connect = realSocketConnect;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tls as any).connect = realTlsConnect;
    }

    expect(attempts).toEqual([]);
    for (const id of ids) {
      const [fs] = await tx.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
      // The intent is written and the move is still OWED — which is the positive statement of the
      // invariant: the worker's reconciler is what talks to the server.
      expect(fs!.desiredFolder).toBe("ohmail/Screener");
      expect(fs!.reconcileStatus).toBe("pending");
    }
  });
});
