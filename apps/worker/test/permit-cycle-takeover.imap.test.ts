import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { LeaseSelf } from "@trafficflow/core/adapters/organizer-lease";
import { OrganizerStandDownError, acquireLeasePermit, readMailboxLease } from "../src/lease.js";
import { reconcileMailbox } from "../src/sync.js";
// THE ONE RESOLVER for which GreenMail a run reads, and it carries the refusal that matters: an
// `IMAP_PORT` without an `SMTP_PORT` reads from a lane's own container and DELIVERS into the
// shared box. Reading the two variables here instead would be a second resolver without it.
import { greenmailPorts } from "./_greenmail-ports.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ═══ ONE REAL MOVE, ONE REAL HANDOVER, ONE REAL SERVER ═══════════════════════════════════════
 *
 * `permit-through-the-cycle.test.ts` drives the same mechanism with a permit double. A double that
 * answers differently hides a defect twice, so this case has no doubles in the path that matters:
 * two real `ImapAdapter`s on one GreenMail mailbox, a real claim in `ohmail/_meta`, the worker's own
 * door (`readMailboxLease`) for the takeover, a real `LeasePermit`, and real `UID MOVE`s.
 *
 * The person is filing three messages. Cloud moves the first. While that move's bookkeeping is
 * being written, the person picks their laptop as the organizer — the laptop's gate expunges
 * Cloud's claim and appends its own. Cloud's NEXT page asks the permit, the stamp probe sees the
 * folder has moved, a real gate runs, and Cloud stands down. The measurement is the SERVER: one
 * message filed, two still in the INBOX, and the laptop's own cycle takes it from there.
 *
 * Before the threading, Cloud's cycle held no permit at all, so all three moved.
 *
 * The takeover is fired from the repo's own completion write, which is the only deterministic
 * anchor there is: "the first move has landed" is a fact this fixture observes rather than a delay
 * it hopes for.
 */

/** A fresh GreenMail user per case → one physical mailbox, isolated from every other case. */
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

interface World { adapter: ImapAdapter; self: LeaseSelf }

async function makeWorld(cfg: ImapConfig, installId: string, kind: "local" | "cloud"): Promise<World> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  await adapter.ensureFolders(FIXTURE_DOOR);
  return { adapter, self: { installId, kind, displayName: `${installId}'s machine`, lastNonce: null } };
}

/** GreenMail's hierarchy delimiter is `.`, so a canonical path is spelled the server's way. */
const serverPath = (canonical: string): string => canonical.split("/").join(".");

async function raw(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await c.connect();
  return c;
}

/** Three messages in the INBOX, and the `uidvalidity:uid` locator of each, as the server minted it. */
async function seedInbox(cfg: ImapConfig): Promise<NativeLocator[]> {
  const c = await raw(cfg);
  try {
    for (const n of [1, 2, 3]) {
      await c.append("INBOX", [
        `Subject: fixture ${n}`, "From: someone@trafficflow.test", "", `body ${n}`,
      ].join("\r\n"), ["\\Seen"]);
    }
    const box = await c.mailboxOpen("INBOX");
    const uidValidity = String(box.uidValidity);
    const locators: NativeLocator[] = [];
    for await (const m of c.fetch("1:*", { uid: true })) {
      locators.push({ folder: "INBOX", ref: `${uidValidity}:${m.uid}` });
    }
    return locators;
  } finally { await c.logout(); }
}

async function countIn(cfg: ImapConfig, canonical: string): Promise<number> {
  const c = await raw(cfg);
  try {
    const status = await c.status(serverPath(canonical), { messages: true });
    return status.messages ?? 0;
  } finally { await c.logout(); }
}

// Two worlds on a real server and a seeded inbox per case, no wait of its own: 2.3-2.9 s on the CI VMs.
describe("a handover mid-scan stops the losing cycle within a page, on a real server", { timeout: 30_000 }, () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });

  it("files the page it held and issues no move after the takeover", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const cloud = await makeWorld(cfg, "ohmail-cloud:test", "cloud");
    const laptop = await makeWorld(cfg, "the-laptop", "local");
    open.push(cloud.adapter, laptop.adapter);

    const locators = await seedInbox(cfg);
    expect(locators, "the fixture needs three real messages").toHaveLength(3);

    const t0 = new Date();
    // THE PERMIT'S OWN LIVE CLOCKS: this permit renews when the probe reports the folder moved,
    // and two gate runs sharing one millisecond are the self-stand-down `MIN_PERMIT_TTL_MS` exists for.
    const permit = await acquireLeasePermit({
      adapter: cloud.adapter, self: cloud.self, mailboxId, hasRequestKey: false,
    });
    expect(permit.reads).toBe(1);

    /** Whether the laptop has taken the mailbox yet — the takeover fires once, after move one. */
    let seized = false;
    const moved: string[] = [];
    const stub = {
      mailboxStatusForWrite: async (): Promise<string> => "connected",
      // THREE DESTINATIONS, THREE GROUPS, THREE PAGES: `reconcileFolders` keys a group on
      // (source → physical destination) and files one group per `moveMany`, so one destination
      // would make the whole filing a single page and the case could not distinguish "stopped
      // within a page" from "never started".
      listPendingFolderStates: async () => [
        { messageId: "m-1", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[0]! },
        { messageId: "m-2", desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[1]! },
        { messageId: "m-3", desiredFolder: "ohmail/Screener", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[2]! },
      ],
      listPendingFlagStates: async () => [],
      updateLocator: async (messageId: string) => { moved.push(messageId); },
      upsertFolderState: async () => {},
      completeFolderState: async () => true,
      upsertFlagState: async () => {},
      primaryInstanceVanished: async () => false,
      deferFolderReconcile: async () => {},
      deferFlagReconcile: async () => {},
      /**
       * THE HANDOVER, FIRED FROM THE FIRST MOVE'S OWN BOOKKEEPING. `recordAudit` is called inside
       * the write group that follows a landed `UID MOVE`, so "the laptop was picked while Cloud
       * was filing" is an observed ordering rather than a timer.
       */
      recordAudit: async (_a: string, action: string): Promise<void> => {
        if (action !== "reconcile.move" || seized) return;
        seized = true;
        const out = await readMailboxLease({
          adapter: laptop.adapter, self: laptop.self, mailboxId, now: new Date(),
          hasRequestKey: false, takeover: { authorizedAt: t0, intent: "takeover" },
        });
        expect(out.organize, "the laptop's own gate must take the mailbox").toBe(true);
      },
    };
    const repo = {
      ...stub,
      transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
    } as unknown as WorkerRepo;

    const err = await reconcileMailbox({
      repo, adapter: cloud.adapter, accountId: "acct", mailboxId,
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: permit,
    }).then(() => null, (e: unknown) => e);

    // ── THE SERVER FIRST, BECAUSE IT IS THE ONLY MEASUREMENT THAT MATTERS ─────────────────────
    //
    // Two messages of somebody's mail, moved or not moved by an install that no longer organizes
    // this mailbox. Asserted ahead of the class and the counters below, so a regression reddens on
    // the harm rather than on the bookkeeping that describes it.
    expect(await countIn(cfg, "ohmail/News")).toBe(1);
    expect(await countIn(cfg, "ohmail/Receipts"), "a move after the handover is the defect").toBe(0);
    expect(await countIn(cfg, "ohmail/Screener")).toBe(0);
    expect(await countIn(cfg, "INBOX"), "the two the cycle did not reach are still where they were")
      .toBe(2);
    expect(moved, "only the page the permit admitted may be recorded as filed").toEqual(["m-1"]);

    expect(err, "the losing cycle's own verdict is the stand-down").toBeInstanceOf(OrganizerStandDownError);
    expect((err as OrganizerStandDownError).reason).toBe("organized_elsewhere:local");
    expect(permit.revoked).toBe(true);
    // A REAL re-read: the probe saw `ohmail/_meta` move and ran the gate, which is the only thing
    // that could answer a takeover inside a TTL nothing here came close to expiring.
    expect(permit.reads).toBe(2);
  });

  it("POSITIVE CONTROL — nobody takes the mailbox, and all three are filed", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const cloud = await makeWorld(cfg, "ohmail-cloud:test", "cloud");
    open.push(cloud.adapter);

    const locators = await seedInbox(cfg);
    const permit = await acquireLeasePermit({
      adapter: cloud.adapter, self: cloud.self, mailboxId, hasRequestKey: false,
    });

    const moved: string[] = [];
    const stub = {
      mailboxStatusForWrite: async (): Promise<string> => "connected",
      listPendingFolderStates: async () => [
        { messageId: "m-1", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[0]! },
        { messageId: "m-2", desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[1]! },
        { messageId: "m-3", desiredFolder: "ohmail/Screener", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locators[2]! },
      ],
      listPendingFlagStates: async () => [],
      updateLocator: async (messageId: string) => { moved.push(messageId); },
      upsertFolderState: async () => {},
      completeFolderState: async () => true,
      upsertFlagState: async () => {},
      primaryInstanceVanished: async () => false,
      deferFolderReconcile: async () => {},
      deferFlagReconcile: async () => {},
      recordAudit: async () => {},
    };
    const repo = {
      ...stub,
      transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
    } as unknown as WorkerRepo;

    await reconcileMailbox({
      repo, adapter: cloud.adapter, accountId: "acct", mailboxId,
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: permit,
    });

    // A permit that refuses too eagerly is the same product defect from the other side: the
    // person's mailbox stops being organized while they hold it.
    expect(moved).toEqual(["m-1", "m-2", "m-3"]);
    expect(permit.revoked).toBe(false);
    expect(await countIn(cfg, "INBOX")).toBe(0);
    expect(await countIn(cfg, "ohmail/News")).toBe(1);
    expect(await countIn(cfg, "ohmail/Receipts")).toBe(1);
    expect(await countIn(cfg, "ohmail/Screener")).toBe(1);
  });
});
