import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { META_FOLDER, type LeaseIo, type LeaseSelf } from "@trafficflow/core/adapters/organizer-lease";
import {
  OrganizerStandDownError, acquireLeasePermit, assertMayWriteToMailbox, readMailboxLease,
} from "../src/lease.js";
import { FIXTURE_DOOR } from "./_door.js";
import { PermitClock } from "./_permit-clock.js";

/**
 * ═══ A PERMIT IS ONLY AS GOOD AS THE CLAIM IT WAS ISSUED UNDER ════════════════════════════════
 *
 * `TWO-ORGANIZERS-DURING-A-CHOSEN-HANDOVER`. The person picks B as the organizer of a mailbox A is
 * organizing. B's gate removes A's claim from `ohmail/_meta` and starts. A holds a permit taken
 * seconds earlier, and until this fix A went on authorizing writes on the strength of it — for a
 * whole minute, or its whole budget of write boundaries, whichever came first. Two organizers across the
 * handover, on the one invariant CLAUDE.md calls load-bearing.
 *
 * The reproduction drives the REAL pipeline: two real `ImapAdapter`s against one GreenMail
 * mailbox, the worker's own door (`readMailboxLease`) for the takeover, the permit every
 * destructive pass in this tree carries, and `assertMayWriteToMailbox` — the one predicate a write
 * site asks. Nothing here is a double: the claim is a message, the takeover is an APPEND and an
 * EXPUNGE, and the folder is the only medium the two installs share.
 *
 * ── MUTATIONS WATCHED (each restored, verified by `cmp`) ─────────────────────────────────────
 *
 *  1.  `check()` skips the stamp probe (`if (await movedSince())` becomes `if (false)`)
 *      ⇒ 2 RED. The handover case and the stranger case both: the permit rides its clock to the
 *        boundary again, which is the defect exactly.
 *  2.  `sameMetaStamp` drops the `uidNext` term
 *      ⇒ 2 RED, and this is the measurement that decides the term. A real takeover on this server
 *        expunges our claim and appends its own, so `messages` comes back to what it was and the
 *        uid space is the only thing that says anything moved.
 *  3.  the baseline reading is taken BEFORE the gate's renew instead of the instant after it
 *      ⇒ RED across this file and `lease-permit.test.ts`. With the fake it is a gate run per
 *        write (the folder moved under our own append); on a fresh server the folder does not
 *        exist until the gate creates it, so the permit is left unstamped and the handover is
 *        missed — the same defect, wearing the degraded mode's clothes.
 *  4.  the baseline is taken inside the permit again, after the row write, instead of coming
 *      from `MailboxLeaseOutcome.stamp`
 *      ⇒ "a hand-over landing while the row is written" RED: the rival's claim is inside the
 *        baseline, the boundary reads "nothing moved", and this organizer goes on writing.
 */

type Cfg = ImapConfig;

/** A fresh GreenMail user per case → one physical mailbox, isolated from every other case. */
function cfgOf(): Cfg {
  const user = `t-${randomUUID()}@trafficflow.test`;
  return {
    host: process.env.IMAP_HOST ?? "127.0.0.1",
    port: Number(process.env.IMAP_PORT ?? 3143),
    secure: false,
    auth: { user, pass: "test" },
    smtp: { host: process.env.SMTP_HOST ?? "127.0.0.1", port: Number(process.env.SMTP_PORT ?? 3025), secure: false },
    sentDomain: "trafficflow.test",
  };
}

interface World {
  adapter: ImapAdapter;
  self: LeaseSelf;
}

async function makeWorld(cfg: Cfg, installId: string, kind: "local" | "cloud"): Promise<World> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  await adapter.ensureFolders(FIXTURE_DOOR);
  return { adapter, self: { installId, kind, displayName: `${installId}'s machine`, lastNonce: null } };
}

/** GreenMail's hierarchy delimiter is `.`, so the canonical path is spelled the server's way. */
const SERVER_META = META_FOLDER.split("/").join(".");

/** A record in `ohmail/_meta` that is not a claim — what a reader's request looks like from here. */
async function appendStranger(cfg: Cfg): Promise<void> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    await c.append(SERVER_META, [
      "X-Ohmail-Request: 1", "Subject: a reader decided something", "", "",
    ].join("\r\n"), ["\\Seen"]);
  } finally {
    await c.logout();
  }
}

describe("the organizer permit against a chosen handover, on a real server", () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });
  const track = (w: World): World => {
    open.push(w.adapter);
    return w;
  };

  /**
   * THE CASE THE FINDING NAMES. The clock is held still and one check is spent, so neither of the
   * permit's two boundary triggers is anywhere near firing: what refuses the write has to be the
   * claim's removal itself.
   */
  it("refuses this organizer's very next write once a takeover has removed its claim", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));
    const b = track(await makeWorld(cfg, "ohmail-cloud:test", "cloud"));

    const t0 = new Date();
    const permit = await acquireLeasePermit({
      adapter: a.adapter, self: a.self, mailboxId, hasRequestKey: false,
      // HELD STILL: the TTL can never expire in this case, so a refusal cannot come from the clock.
      ...new PermitClock(t0.getTime()).pair,
    });
    // Positive control, before anything happens: the mailbox is ours and the write is admitted.
    await assertMayWriteToMailbox({ lease: permit }, "move");
    expect(permit.reads).toBe(1);

    const seized = await readMailboxLease({
      adapter: b.adapter, self: b.self, mailboxId, now: new Date(t0.getTime() + 1_000),
      hasRequestKey: false, takeover: { authorizedAt: t0, intent: "takeover" }, onNonceMinted: () => undefined,
    });
    expect(seized.organize).toBe(true);

    // THE FIRST CHECK AFTER THE HANDOVER, and it is the second write boundary of the budget.
    const refused = await assertMayWriteToMailbox({ lease: permit }, "move").then(
      () => null, (err: unknown) => err,
    );
    expect(refused, "the permit authorized a write to a mailbox somebody else now organizes")
      .toBeInstanceOf(OrganizerStandDownError);
    expect((refused as OrganizerStandDownError).reason).toBe("organized_elsewhere:cloud");
    expect((refused as OrganizerStandDownError).heldBy).toBe("ohmail-cloud:test's machine");
    expect(permit.revoked).toBe(true);
    expect(permit.writesSinceRead).toBeLessThan(100);
  });

  /**
   * THE POSITIVE CONTROL, and the cost statement beside it: a mailbox nobody touched is probed at
   * every boundary and re-read at none of them. A probe that re-read anyway would pay a gate run —
   * an APPEND, an EXPUNGE and a whole-folder read — per filed message.
   */
  it("leaves a permit whose claim is intact alone: ten boundaries, one read", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));

    const t0 = new Date();
    const permit = await acquireLeasePermit({
      adapter: a.adapter, self: a.self, mailboxId, hasRequestKey: false, ...new PermitClock(t0.getTime()).pair,
    });
    for (let i = 0; i < 10; i++) await assertMayWriteToMailbox({ lease: permit }, "move");

    expect(permit.reads).toBe(1);
    expect(permit.revoked).toBe(false);
    expect(permit.writesSinceRead).toBe(10);
  });

  /**
   * A FOLDER THAT MOVED FOR A BENIGN REASON COSTS ONE RE-READ, NOT A REFUSAL. The probe reports
   * that something changed, never what; the gate's own election is what decides, and it decides
   * `organize` because our claim is still the only one. The next boundary is quiet again — the
   * baseline moved with the read.
   */
  it("re-reads once when a stranger's record lands in the folder, and keeps organizing", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));

    const t0 = new Date();
    const permit = await acquireLeasePermit({
      adapter: a.adapter, self: a.self, mailboxId, hasRequestKey: false,
      // THE PERMIT'S OWN LIVE CLOCKS, because this permit renews: two gate runs sharing one
      // millisecond are the hazard `MIN_PERMIT_TTL_MS` exists for, and a frozen clock would make it.
    });
    await assertMayWriteToMailbox({ lease: permit }, "move");
    expect(permit.reads).toBe(1);

    await appendStranger(cfg);

    await assertMayWriteToMailbox({ lease: permit }, "move");
    expect(permit.reads, "a folder that moved was not looked at again").toBe(2);
    expect(permit.revoked).toBe(false);

    await assertMayWriteToMailbox({ lease: permit }, "move");
    expect(permit.reads, "the baseline did not move with the read").toBe(2);
  });

  /**
   * THE GAP THE BASELINE USED TO BE TAKEN ON THE WRONG SIDE OF, on the real thing.
   *
   * `onClaimHeld` is the row write that follows the claim, and it is the one thing that runs
   * between the verified claim and the baseline. A rival's gate lands inside it. With the reading
   * taken after that gap the rival's own claim is part of the baseline, so this permit's next
   * budget of writes sees a folder that "has not moved" — two organizers across the hand-over. The
   * clock is held still, so nothing here can be the TTL.
   */
  it("refuses the next write when a hand-over lands while the row that follows the claim is written", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));
    const b = track(await makeWorld(cfg, "ohmail-cloud:test", "cloud"));

    const t0 = new Date();
    let seizedOk = false;
    const permit = await acquireLeasePermit({
      adapter: a.adapter, self: a.self, mailboxId, hasRequestKey: false, ...new PermitClock(t0.getTime()).pair,
      onClaimHeld: async () => {
        // The user picks the other install WHILE this one is writing its row. A real press: the
        // rival's gate displaces our claim and appends its own, through the product's own door.
        const seized = await readMailboxLease({
          adapter: b.adapter, self: b.self, mailboxId, now: new Date(t0.getTime() + 1_000),
          hasRequestKey: false, takeover: { authorizedAt: t0, intent: "takeover" }, onNonceMinted: () => undefined,
        });
        seizedOk = seized.organize;
      },
    });
    expect(seizedOk, "the fixture's hand-over did not land, so this case measures nothing").toBe(true);

    // THE FIRST WRITE BOUNDARY, and the first of the budget. The clock has not moved.
    const refused = await assertMayWriteToMailbox({ lease: permit }, "move").then(
      () => null, (err: unknown) => err,
    );
    expect(refused, "the baseline swallowed a hand-over that landed inside the row's own window")
      .toBeInstanceOf(OrganizerStandDownError);
    expect((refused as OrganizerStandDownError).reason).toBe("organized_elsewhere:cloud");
    expect(permit.revoked).toBe(true);
    expect(permit.writesSinceRead).toBeLessThan(100);
  });

  /**
   * THE DEGRADED MODE, NAMED. A connection that cannot answer the stamp question keeps exactly the
   * bound it had — the clock and the write count — and says so once. Reachable rather than
   * theoretical: `stampMeta` is optional on the interface, and a build that is talking to a server
   * refusing STATUS on that folder is in this arm.
   */
  it("falls back to the boundary, and says so, when the connection cannot stamp the folder", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));
    const b = track(await makeWorld(cfg, "ohmail-cloud:test", "cloud"));

    const lines: string[] = [];
    const blind = {
      leaseIo: (id: { installId: string; mailboxId: string }): LeaseIo => {
        const io = a.adapter.leaseIo(id) as LeaseIo & { stampMeta?: unknown };
        delete io.stampMeta;
        return io;
      },
    } as unknown as typeof a.adapter;

    const t0 = new Date();
    const permit = await acquireLeasePermit({
      adapter: blind, self: a.self, mailboxId, hasRequestKey: false, ...new PermitClock(t0.getTime()).pair,
      log: (event) => lines.push(event),
    });
    await readMailboxLease({
      adapter: b.adapter, self: b.self, mailboxId, now: new Date(t0.getTime() + 1_000),
      hasRequestKey: false, takeover: { authorizedAt: t0, intent: "takeover" }, onNonceMinted: () => undefined,
    });

    // The pre-fix behaviour, and it is the honest one for a connection that cannot ask: the write
    // is admitted to the boundary. The line is what makes it visible rather than silent.
    await assertMayWriteToMailbox({ lease: permit }, "move");
    expect(lines).toContain("lease_permit_unstamped");
  });
});
