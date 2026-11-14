import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import { accounts, mailboxes, mailboxCredentials, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { eq } from "drizzle-orm";
import { makeMailboxService } from "../src/mailbox-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * **AUTHORIZING A TAKEOVER OPENS NO IMAP CONNECTION.** Invariant 3, as a test that can fail.
 *
 * The IMAP mailbox is the master, and organization lands in real folders on the user's server —
 * put there by the always-on worker, through desired state, so that a serverless function can
 * never leave a mailbox half-moved. A confirm that dialled would be a second organizer deciding
 * things in a process with no lease and no lifecycle, at exactly the moment the question is who
 * the organizer is.
 *
 * It is also the honest reading of what this action IS. It does not win a mailbox; it records that
 * a human asked for one. The claim in `ohmail/_meta` is read by the worker's gate afterwards, and
 * if another organizer is still renewing and outranks us, this side stands down again on that same
 * pass — which is why the confirm has nothing to look at and nothing to decide.
 *
 * Three independent guards, each catching a different way of breaking it:
 *
 *  1. **The module graph.** Neither `imapflow` nor either IMAP-facing module in `packages/core` is
 *     reachable from `mailbox-service.ts`. The static half, and the only one that holds for a path
 *     no test enters.
 *  2. **The constructor.** `imapflow` throws on construction for the length of the run.
 *  3. **The socket.** `net.Socket.prototype.connect` and `tls.connect` are trapped, which catches
 *     a hand-rolled connection that never touches imapflow. Loopback is deliberately NOT exempted:
 *     a local GreenMail on 3143 is exactly the connection this forbids.
 */

vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() {
      throw new Error("IMAP_CLIENT_CONSTRUCTED: authorizing a takeover must not open IMAP");
    }
  },
}));

const SRC = fileURLToPath(new URL("../src/mailbox-service.ts", import.meta.url));

describe("MailboxService.organizeHere opens no IMAP connection when no password is supplied", () => {
  it("the service module names neither imapflow nor an IMAP adapter", () => {
    const body = readFileSync(SRC, "utf8");
    // Match the IMPORT MACHINERY, not the word: this file discusses IMAP at length, and a guard
    // satisfied by deleting a comment guards nothing.
    const imports = [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec, `mailbox-service imports ${spec}`)
        .not.toMatch(/imapflow|adapters\/imap|adapters\/organizer-lease/);
    }
  });

  it("a confirm on a stood-down mailbox constructs no client and opens no socket", async () => {
    const pglite = await makeTestDb();
    const tx = pglite as unknown as Tx;

    const accountId = randomUUID();
    await tx.insert(accounts).values({ id: accountId, name: "takeover-no-imap" });
    const [mb] = await tx.insert(mailboxes).values({
      accountId, provider: "imap", address: "held@example.test",
      // Exactly what the worker's demotion write leaves behind since mail 0083: the ROLE and the
      // holder, `status` untouched. It used to be `disabled` + a reason, which nothing writes any
      // more — a fixture in that shape would set up a state that cannot occur, and the claim
      // below would be about it rather than about the product.
      organizerRole: "reader",
      organizedByKind: "local",
      organizedByName: "somebody's laptop",
      organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"),
    }).returning();
    // A STORED CREDENTIAL. The claim-back with no password in the body requires one — a stamp on
    // a mailbox with nothing to log in with authorizes a becoming the worker cannot perform. The
    // row is written directly because this file's claim is about SOCKETS, and the encryption is
    // not part of it; what matters is that the ceremony has something to find without dialling.
    await tx.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: "sealed", keyVersion: 1,
      meta: { host: "imap.example.test", port: 993, secure: true, user: "u" },
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    // The allowance is satisfied rather than exercised — its refusal is driven against real
    // Postgres in `mailbox-takeover.concurrency.pg.test.ts`. A policy that could refuse would end
    // this test before the thing under test ever ran.
    const svc = makeMailboxService({ allowance: async () => { /* permitted */ } });
    const ctx: ServiceContext = {
      db: pglite as unknown as ServiceContext["db"],
      accountId, userId: null, now: () => new Date("2026-08-05T12:00:00.000Z"), requestId: "r",
    };

    const attempts: string[] = [];
    const realSocketConnect = net.Socket.prototype.connect;
    const realTlsConnect = tls.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    net.Socket.prototype.connect = function (...args: any[]): never {
      attempts.push(`net.Socket.connect(${JSON.stringify(args[0])})`);
      throw new Error("SOCKET_OPENED: authorizing a takeover must not open a connection");
    } as typeof net.Socket.prototype.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tls as any).connect = (...args: any[]): never => {
      attempts.push(`tls.connect(${JSON.stringify(args[0])})`);
      throw new Error("SOCKET_OPENED: authorizing a takeover must not open a connection");
    };

    try {
      const result = await svc.organizeHere(ctx, mb!.id, { intent: "takeover" });
      // THE WORK ACTUALLY HAPPENED. A guard that passes because nothing ran is not a guard.
      expect(result.outcome).toBe("authorized");
      /* -- AND IT NAMES WHAT THE MAILBOX WAS TAKEN BACK FROM ------------------------------
       *
       * `previousReason` read `disabled_reason`, which mail 0083 left with no writer — so on
       * the fixture above, which is exactly the shape a demotion produces, it answered `null`
       * and the person claiming their mailbox back was told nothing about who had it. It is
       * derived from the role and the holder kind now, and `organized_by_kind: 'local'` two
       * dozen lines up is what makes this string the right one.
       */
      expect(result.outcome === "authorized" && result.previousReason,
        "the reclaim reported no previous holder for a mailbox a laptop had taken")
        .toBe("organized_elsewhere:local");
    } finally {
      net.Socket.prototype.connect = realSocketConnect;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tls as any).connect = realTlsConnect;
    }

    expect(attempts).toEqual([]);

    // And the positive statement of the invariant: the intent is recorded and the BECOMING is
    // still owed. Nothing here made this side the organizer — the worker's gate decides, against
    // the claim in the mailbox, on its next pass.
    const [after] = await tx.select().from(mailboxes).where(eq(mailboxes.id, mb!.id)).limit(1);
    expect(after!.status).toBe("connected");
    expect(after!.disabledReason).toBeNull();
    expect(after!.takeoverAuthorizedAt).not.toBeNull();
    // AND THE ROLE IS UNCHANGED. The gate promotes, in the process that will do the organizing,
    // after reading the claim in the mailbox — which is the other half of why this door opens no
    // socket. A method that flipped the role here would be deciding from a serverless function
    // what only the mailbox can decide.
    expect(after!.organizerRole).toBe("reader");
  });

  it("with no password in the press and no login stored, the takeover is refused and nothing is stamped", async () => {
    const pglite = await makeTestDb();
    const tx = pglite as unknown as Tx;
    const accountId = randomUUID();
    await tx.insert(accounts).values({ id: accountId, name: "takeover-no-login" });
    const [mb] = await tx.insert(mailboxes).values({
      accountId, provider: "imap", address: "bare@example.test",
      organizerRole: "reader", organizedByKind: "local", organizedByName: "somebody's laptop",
      organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"),
    }).returning();
    const svc = makeMailboxService({ allowance: async () => { /* permitted */ }, signatureChecks: false });
    const ctx: ServiceContext = {
      db: pglite as unknown as ServiceContext["db"],
      accountId, userId: null, now: () => new Date("2026-08-05T12:00:00.000Z"), requestId: "r",
    };

    const refused = await svc.organizeHere(ctx, mb!.id, { intent: "takeover" }).then(() => null, (e: unknown) => e);
    // The refusal asks for the password and is not worth repeating as it stands.
    expect(refused).toMatchObject({ code: "credential_needed", httpStatus: 422, retryable: false });

    const [after] = await tx.select().from(mailboxes).where(eq(mailboxes.id, mb!.id)).limit(1);
    expect(after!.takeoverAuthorizedAt).toBeNull();
    expect(after!.organizerRole).toBe("reader");
  });
});
