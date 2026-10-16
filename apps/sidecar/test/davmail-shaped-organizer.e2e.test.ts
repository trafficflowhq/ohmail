import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { openLocalDb } from "../src/db.js";
import { authorizeOrganizerTakeover } from "../src/organize-here.js";
import { greenmailConfig } from "../../../packages/core/test/adapters/_imapenv.js";
import { startDavmailLike, type DavmailLike, type DavmailLikeOptions } from "../../../packages/core/test/adapters/_davmail-like.js";

/**
 * ═══ RIG (c): THE DESKTOP'S ORGANIZER ON A SERVER THAT ANSWERS LIKE DAVMAIL 7.0.0 ══════════
 *
 * No `adapterFactory`: the engine dials the relay on loopback with the real `ImapAdapter`, as it
 * would dial DavMail on 127.0.0.1:1143. The relay (`_davmail-like.ts` in core's tests) answers in
 * DavMail's wire shapes over the lane GreenMail. Asked of it: the lease claimed and renewed, the
 * folders created under their parent, first contact filed (no COPYUID, adopted by the next scan),
 * a second launch, and INTERNALDATE present and absent.
 */

const running: Sidecar[] = [];
const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop().catch(() => undefined);
  while (closers.length > 0) await Promise.resolve(closers.pop()!()).catch(() => undefined);
});

const META_PATH = META_FOLDER.split("/").join(".");

function eml(o: { to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, "From: stranger@elsewhere.test", `To: ${o.to}`, `Subject: ${o.subject}`,
    "Date: Wed, 07 Oct 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "",
    "Hello, we have not met before.",
  ].join("\r\n");
}

async function direct<T>(cfg: ReturnType<typeof greenmailConfig>, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

type ClaimSeen = { installId: string; kind: string; deleted: boolean; heartbeat: number };

/** One read of `ohmail/_meta` on GreenMail past the relay: every claim, and whether it is marked `\Deleted`. */
async function claimsRead(cfg: ReturnType<typeof greenmailConfig>): Promise<ClaimSeen[]> {
  return direct(cfg, async (c) => {
    if (!(await c.list()).some((f) => f.path === META_PATH)) return [];
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const out: ClaimSeen[] = [];
      for await (const m of c.fetch("1:*", { uid: true, headers: true, flags: true })) {
        const claim = m.headers ? parseClaim(m.headers.toString("utf8")) : null;
        if (claim && !("malformed" in claim)) {
          out.push({
            installId: claim.installId, kind: claim.kind,
            deleted: m.flags?.has("\\Deleted") ?? false, heartbeat: claim.heartbeat.getTime(),
          });
        }
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/**
 * The claims STANDING in `ohmail/_meta`, read between renews. A renew appends the new claim, marks
 * the old one `\Deleted` and expunges it (`organizer-lease.ts`, at ORGANIZER_KIND_WORDS), so a read
 * landing inside that window sees one install twice — measured on this rig: the old uid flagged
 * `\Deleted` beside the new one, gone 100 ms later. That is the protocol, not a second claim, and a
 * single read could not tell the two apart. So this reads until a read shows no `\Deleted` record
 * and no install twice, and answers what that read holds; a duplicate that never clears is
 * answered as it stands after the bound, and the caller's assertion names it.
 */
async function claimsOn(cfg: ReturnType<typeof greenmailConfig>): Promise<Array<{ installId: string; kind: string }>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const seen = await claimsRead(cfg);
    const ids = seen.map((s) => s.installId);
    const settled = !seen.some((s) => s.deleted) && new Set(ids).size === ids.length;
    if (settled || Date.now() > deadline) return seen.map(({ installId, kind }) => ({ installId, kind }));
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function inFolder(cfg: ReturnType<typeof greenmailConfig>, path: string, messageId: string): Promise<number> {
  return direct(cfg, async (c) => {
    const lock = await c.getMailboxLock(path);
    try {
      const hits = await c.search({ header: { "message-id": messageId } }, { uid: true });
      return Array.isArray(hits) ? hits.length : 0;
    } finally {
      lock.release();
    }
  });
}

async function until(pred: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

async function world(o: Omit<DavmailLikeOptions, "upstream"> = {}) {
  const base = greenmailConfig();
  const ids = [`dm-a-${randomUUID()}@x`, `dm-b-${randomUUID()}@x`];
  await direct(base, async (c) => {
    for (const [i, messageId] of ids.entries()) {
      await c.append("INBOX", eml({ to: base.auth.user, subject: `first contact ${i}`, messageId }));
    }
  });
  const gm: DavmailLike = await startDavmailLike({ upstream: { host: base.host, port: base.port }, ...o });
  closers.push(() => gm.close());
  const dir = mkdtempSync(join(tmpdir(), "ohmail-davmail-rig-"));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  const imap = { host: gm.host, port: gm.port, secure: false, auth: base.auth };
  const lines: string[] = [];
  const launch = async (): Promise<Sidecar> => {
    const s = await createSidecar({
      dataDir: dir, imap, machineName: "DavMail rig", pollIntervalMs: 300, leaseStaleAfterMs: 60_000,
      log: (event: string) => { lines.push(event); },
    } as never);
    running.push(s);
    await grantOrganizeConsent(s);
    await s.start();
    return s;
  };
  return { base, gm, ids, launch, lines };
}

describe("rig (c) — the organizer on a DavMail-shaped server", () => {
  it("claims, builds ohmail/ under its parent, files first contact, renews and survives a second launch", async () => {
    const { base, gm, ids, launch } = await world();
    const first = await launch();
    expect(first.organizerState()).toMatchObject({ organizing: true, claimed: true });
    // the parent first, then the five and the lease, and not one CREATE refused.
    expect(gm.refusedCreates).toEqual([]);
    expect(gm.creates[0]).toBe("ohmail");
    expect(await claimsOn(base)).toEqual([{ installId: first.world.accountId, kind: "local" }]);

    // First contact goes to the Screener: UID MOVE answered with no COPYUID, adopted later.
    await until(async () => (await inFolder(base, "ohmail.Screener", ids[0]!)) === 1
      && (await inFolder(base, "ohmail.Screener", ids[1]!)) === 1, 30_000, "first contact in the Screener");
    /* No COPYUID: the move lands unmapped and a later scan adopts the row at its new uid, under
       the generation DavMail always states (1). */
    const locators = async (): Promise<string[]> => (await first.db.select().from(messages))
      .map((r) => JSON.stringify((r as { nativeLocator?: unknown }).nativeLocator ?? null));
    await until(async () => {
      const ls = await locators();
      return ls.length === 2 && ls.every((l) => {
        const at = JSON.parse(l) as { folder?: string; ref?: string } | null;
        return at?.folder === "ohmail/Screener" && /^1:\d+$/.test(at.ref ?? "");
      });
    }, 30_000, "the moved rows adopted under ohmail/Screener").catch(async (e: unknown) => {
      throw new Error(`${(e as Error).message}; locators now ${JSON.stringify(await locators())}`);
    });

    // Renews: several poll cycles, one claim standing, and no command DavMail would never answer.
    const before = gm.connections;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(gm.uidExpungesUnanswered).toBe(0);
    expect(await claimsOn(base)).toHaveLength(1);
    expect(gm.connections - before, "the poll re-dialled: a command went unanswered").toBe(0);

    // A second launch on the same store finds its own claim and organizes again.
    await first.stop();
    running.splice(running.indexOf(first), 1);
    const second = await launch();
    expect(second.organizerState()).toMatchObject({ organizing: true, claimed: true });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await claimsOn(base)).toEqual([{ installId: second.world.accountId, kind: "local" }]);
    expect(gm.refusedCreates).toEqual([]);
    expect(gm.uidExpungesUnanswered).toBe(0);
  }, 120_000);

  it("INTERNALDATE absent: no hang, one claim, and the missing server clock said by name (ruled default)", async () => {
    const { base, gm, ids, launch, lines } = await world({ internalDate: "absent" });
    const s = await launch();
    expect(s.organizerState()).toMatchObject({ organizing: true, claimed: true });
    await until(async () => (await inFolder(base, "ohmail.Screener", ids[0]!)) === 1, 30_000, "first contact filed");
    // A renew reads our own claim back with no server clock: said once, never per cycle.
    await until(async () => lines.includes("lease_server_clock_unavailable"), 30_000, "the named line");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(lines.filter((l) => l === "lease_server_clock_unavailable")).toHaveLength(1);
    expect(gm.internalDatesRemoved).toBeGreaterThan(0);
    expect(await claimsOn(base)).toHaveLength(1);
    expect(gm.uidExpungesUnanswered).toBe(0);
  }, 120_000);

  /**
   * RULED REQUIRED ARM (2026-10-07, internaldate-absent): with no server clock at all, two desktop
   * engines through one DavMail-shaped relay contend for one mailbox, and exactly one organizes —
   * across at least three renews, and across a takeover. One organizer per mailbox is the invariant
   * the lease exists for, and it must hold on the heartbeat ranking alone.
   */
  it("INTERNALDATE absent: two engines, exactly one organizes, through three renews and a takeover", async () => {
    const base = greenmailConfig();
    const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port }, internalDate: "absent" });
    closers.push(() => gm.close());
    const imap = { host: gm.host, port: gm.port, secure: false, auth: base.auth };
    const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "ohmail-davmail-two-")));
    for (const d of dirs) closers.push(() => rmSync(d, { recursive: true, force: true }));
    const launchAt = async (dir: string, name: string): Promise<Sidecar> => {
      const s = await createSidecar({
        dataDir: dir, imap, machineName: name, pollIntervalMs: 300, leaseStaleAfterMs: 60_000,
        log: () => {},
      } as never);
      running.push(s);
      await grantOrganizeConsent(s);
      await s.start().catch(() => undefined);
      return s;
    };
    const deliver = async (messageId: string): Promise<void> => {
      await direct(base, (c) => c.append("INBOX", eml({ to: base.auth.user, subject: "first contact", messageId })).then(() => undefined));
    };
    /**
     * Sample both engines until the organizer has renewed `renews` times (and for at least ten
     * samples); every sample must have exactly one organizing, the expected one. COUNTED IN RENEWS,
     * NOT IN TIME: a renew rides the organizer's cycle, and the cycle's length is the local store's
     * work — measured on this rig at 1.6 s apart on an idle machine and 5 s apart under load, with a
     * 2.8 s store checkpoint in the cycle. A fixed 9 s window counted anywhere from one renew to five
     * for the same correct engine. The bound is only for an organizer that never renews at all.
     */
    const window = async (organizer: Sidecar, reader: Sidecar, renews: number): Promise<void> => {
      const appended = (): number => gm.appends.filter((a) => a === "ohmail/_meta").length;
      const startAppends = appended();
      const deadline = Date.now() + 90_000;
      let samples = 0;
      while (appended() - startAppends < renews || samples < 10) {
        expect(Date.now() < deadline, `fewer than ${renews} renews in 90 s: ${appended() - startAppends}`).toBe(true);
        expect(organizer.organizerState().organizing, "the organizer stopped organizing").toBe(true);
        expect(reader.organizerState().organizing, "TWO ORGANIZERS: the reader organized").toBe(false);
        samples += 1;
        await new Promise((r) => setTimeout(r, 150));
      }
    };

    const a = await launchAt(dirs[0]!, "Desk A");
    expect(a.organizerState()).toMatchObject({ organizing: true });
    const b = await launchAt(dirs[1]!, "Desk B");
    expect(b.organizerState().organizing, "the second engine took a mailbox the first holds").toBe(false);

    const one = `two-1-${randomUUID()}@x`;
    await deliver(one);
    await window(a, b, 3);
    expect(await inFolder(base, "ohmail.Screener", one)).toBe(1);
    expect(await inFolder(base, "INBOX", one)).toBe(0);
    expect((await claimsOn(base)).map((c) => c.installId)).toEqual([a.world.accountId]);

    // The takeover: B is asked to organize here, the press outranks A's live claim.
    await b.stop();
    running.splice(running.indexOf(b), 1);
    const opened = await openLocalDb(dirs[1]!);
    expect((await authorizeOrganizerTakeover(opened.db, { intent: "takeover", address: base.auth.user, now: new Date() })).outcome)
      .toBe("authorized");
    await opened.close();
    const b2 = await launchAt(dirs[1]!, "Desk B");
    expect(b2.organizerState()).toMatchObject({ organizing: true });
    /* A sees the takeover at its next cycle, so this waits on A's own renews, not on a clock. A
       displaced engine that has not renewed since B's claim landed is only slow; one that renews
       over B's standing claim twice more has read the takeover and kept organizing — the
       two-organizers failure, and it is named as that rather than as a timeout. (Its heartbeat
       standing when B claimed is one, and a renew already in flight across B's write is a second.) */
    const heartbeatsOverB = new Set<number>();
    const standDownBy = Date.now() + 90_000;
    while (a.organizerState().organizing) {
      const seen = await claimsRead(base);
      if (seen.some((c) => c.installId === b2.world.accountId && !c.deleted)) {
        for (const c of seen) if (c.installId === a.world.accountId && !c.deleted) heartbeatsOverB.add(c.heartbeat);
      }
      expect(heartbeatsOverB.size, "TWO ORGANIZERS: the displaced engine kept renewing over the takeover's claim")
        .toBeLessThanOrEqual(2);
      expect(Date.now() < standDownBy, "the displaced engine neither stood down nor renewed in 90 s").toBe(true);
      await new Promise((r) => setTimeout(r, 250));
    }

    const two = `two-2-${randomUUID()}@x`;
    await deliver(two);
    await window(b2, a, 3);
    expect(await inFolder(base, "ohmail.Screener", two)).toBe(1);
    expect(await inFolder(base, "INBOX", two)).toBe(0);
    expect((await claimsOn(base)).map((c) => c.installId)).toEqual([b2.world.accountId]);
    expect(gm.internalDatesRemoved).toBeGreaterThan(0);
    expect(gm.uidExpungesUnanswered).toBe(0);
  }, 300_000);
});

