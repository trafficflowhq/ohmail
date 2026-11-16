import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapAdapter, WriteDeclinedError, type ImapConfig } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { acquireLeasePermit, writeDoorOf } from "../src/lease.js";
import { reconcileMailbox } from "../src/sync.js";
import { greenmailPorts } from "./_greenmail-ports.js";
import { LivePermitClock } from "./_permit-clock.js";

/**
 * ═══ THE LIVE PROOF: A CLAIM MADE STALE MID-BATCH DECLINES ITS NEXT WRITE, ON A REAL SERVER ══════
 *
 * A real `ImapAdapter` on a GreenMail mailbox, a real claim in `ohmail/_meta`, a real permit on a
 * clock this case moves, and real `UID MOVE`s. The organizer files two groups. While the second
 * group's destination is being searched — after its page check was served inside the permit's
 * minute — the claim ages past its window. The measurement is the SERVER: the first group filed,
 * the second still in the INBOX, and the folders read the same after the decline as at it.
 */

function cfgOf(): ImapConfig {
  const user = `t-${randomUUID()}@trafficflow.test`;
  const p = greenmailPorts();
  return {
    host: p.imapHost, port: p.imapPort, secure: false,
    auth: { user, pass: "test" },
    smtp: { host: p.smtpHost, port: p.smtpPort, secure: false },
    sentDomain: "trafficflow.test",
  };
}

const serverPath = (canonical: string): string => canonical.split("/").join(".");

async function raw(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

async function seedInbox(cfg: ImapConfig): Promise<NativeLocator[]> {
  const c = await raw(cfg);
  try {
    for (const n of [1, 2]) {
      await c.append("INBOX", [`Subject: fixture ${n}`, "From: someone@trafficflow.test", "", `body ${n}`].join("\r\n"), ["\\Seen"]);
    }
    const box = await c.mailboxOpen("INBOX");
    const locators: NativeLocator[] = [];
    for await (const m of c.fetch("1:*", { uid: true })) {
      locators.push({ folder: "INBOX", ref: `${String(box.uidValidity)}:${m.uid}` });
    }
    return locators;
  } finally { await c.logout(); }
}

async function counts(cfg: ImapConfig): Promise<Record<string, number>> {
  const c = await raw(cfg);
  try {
    const out: Record<string, number> = {};
    for (const f of ["INBOX", "ohmail/News", "ohmail/Receipts"]) {
      out[f] = (await c.status(serverPath(f), { messages: true })).messages ?? 0;
    }
    return out;
  } finally { await c.logout(); }
}

function repoOf(locators: readonly NativeLocator[], filed: string[]): WorkerRepo {
  const stub = {
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    listPendingFolderStates: async () => [
      { messageId: "m-1", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[0]! },
      { messageId: "m-2", desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[1]! },
    ],
    listPendingFlagStates: async () => [],
    updateLocator: async (messageId: string) => { filed.push(messageId); },
    upsertFolderState: async () => {},
    completeFolderState: async () => true,
    upsertFlagState: async () => {},
    primaryInstanceVanished: async () => false,
    deferFolderReconcile: async () => {},
    deferFlagReconcile: async () => {},
    recordAudit: async () => {},
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

describe("the write door on a real server", () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });

  async function organizer(cfg: ImapConfig, clock: LivePermitClock) {
    const adapter = new ImapAdapter(cfg);
    open.push(adapter);
    await adapter.connect();
    const mailboxId = randomUUID();
    const permit = await acquireLeasePermit({
      adapter, mailboxId, hasRequestKey: false, ...clock.pair,
      self: { installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null },
    });
    await adapter.ensureFolders(writeDoorOf({ lease: permit }));
    return { adapter, mailboxId, permit };
  }

  it("a claim that ages out inside the second batch's preflight: that batch writes nothing", async () => {
    const cfg = cfgOf();
    const clock = new LivePermitClock();
    const { adapter, mailboxId, permit } = await organizer(cfg, clock);
    const locators = await seedInbox(cfg);

    // ARMED when the cycle hands the second message to the adapter — after its page check — and
    // spent on the adapter's next read of the server: the claim ages eleven minutes inside that
    // message's preflight, as it would under a closed lid. Whichever path the server's capabilities
    // select (the batch, or one move per message), the jump lands before the command.
    const second = locators[1]!.ref;
    let armed = false;
    let jumped = false;
    const self = adapter as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const verb of ["move", "moveMany"]) {
      const real = self[verb]!.bind(adapter);
      self[verb] = async (...a: unknown[]) => {
        const locs = (Array.isArray(a[0]) ? a[0] : [a[0]]) as NativeLocator[];
        if (locs.some((l) => l.ref === second)) armed = true;
        return real(...a);
      };
    }
    const client = (adapter as unknown as { client: Record<string, (...a: unknown[]) => unknown> }).client;
    for (const read of ["fetchOne", "fetchAll", "search"]) {
      const real = client[read]!.bind(client);
      client[read] = (...a: unknown[]) => {
        if (armed && !jumped) { jumped = true; clock.stepWall(11 * 60 * 1000); }
        return real(...a);
      };
    }

    const filed: string[] = [];
    const err = await reconcileMailbox({
      repo: repoOf(locators, filed), adapter, accountId: "acct", mailboxId,
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: permit,
    }).then(() => null, (e: unknown) => e);

    const atDecline = await counts(cfg);
    expect(atDecline, "the second group moved on a claim older than its window").toEqual({
      INBOX: 1, "ohmail/News": 1, "ohmail/Receipts": 0,
    });
    expect(filed).toEqual(["m-1"]);
    expect(err).toBeInstanceOf(WriteDeclinedError);
    expect((err as WriteDeclinedError).reason).toBe("claim_stale");
    expect(jumped, "the claim aged inside the second message's preflight").toBe(true);
    // AND AFTER IT: nothing further reaches the server from this cycle.
    expect(await counts(cfg)).toEqual(atDecline);
  });

  it("POSITIVE CONTROL — the claim held throughout: both groups file", async () => {
    const cfg = cfgOf();
    const { adapter, mailboxId, permit } = await organizer(cfg, new LivePermitClock());
    const locators = await seedInbox(cfg);
    const filed: string[] = [];
    await reconcileMailbox({
      repo: repoOf(locators, filed), adapter, accountId: "acct", mailboxId,
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: permit,
    });
    expect(filed).toEqual(["m-1", "m-2"]);
    expect(await counts(cfg)).toEqual({ INBOX: 0, "ohmail/News": 1, "ohmail/Receipts": 1 });
  });
});
