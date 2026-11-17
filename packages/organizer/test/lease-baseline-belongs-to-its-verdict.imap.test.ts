import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { META_FOLDER, type LeaseIo, type LeaseSelf } from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap-types";
import {
  OrganizerStandDownError, PERMIT_WRITES_PER_RECHECK, acquireLeasePermit,
  assertMayWriteToMailbox, readMailboxLease,
} from "../src/lease.js";
import { greenmailPorts } from "./_greenmail-ports.js";
import { FIXTURE_DOOR } from "./_door.js";
import { PermitClock } from "./_permit-clock.js";

/**
 * ═══ A BASELINE BELONGS TO THE VERDICT THAT GRANTED IT ════════════════════════════════════════
 *
 * The permit compares the folder's counters against a baseline to answer "does my claim still
 * stand". The baseline used to be a STATUS issued after the gate returned — a separate round trip
 * — so a takeover landing before that STATUS ANSWERED was already inside the reading. Every later
 * boundary then read "nothing moved" against counters that already held the rival's write, and
 * this install went on filing beside the one that took the mailbox, for a whole TTL or its whole budget of
 * writes. Two organizers, on the invariant the product is built on.
 *
 * The reproduction is the real pipeline: two real `ImapAdapter`s against one GreenMail mailbox,
 * the worker's own door for the takeover, and the permit every destructive pass carries. The one
 * injected thing is WHEN the rival lands — a hook on `stampMeta` that runs the takeover before the
 * counters are asked for, which is the instant the defect lives in and not a behaviour change.
 */

/** A fresh GreenMail user per case → one physical mailbox, isolated from every other case. */
function cfgOf(): ImapConfig {
  const p = greenmailPorts();
  const user = `t-${randomUUID()}@trafficflow.test`;
  return {
    host: p.imapHost,
    port: p.imapPort,
    secure: false,
    auth: { user, pass: "test" },
    smtp: { host: p.smtpHost, port: p.smtpPort, secure: false },
    sentDomain: "trafficflow.test",
  };
}

interface World {
  adapter: ImapAdapter;
  self: LeaseSelf;
}

async function makeWorld(cfg: ImapConfig, installId: string, kind: "local" | "cloud"): Promise<World> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  await adapter.ensureFolders(FIXTURE_DOOR);
  return { adapter, self: { installId, kind, displayName: `${installId}'s machine`, lastNonce: null } };
}

/**
 * THE SAME ADAPTER, WITH ONE INSTANT NAMED. Everything is delegated to the live connection; the
 * only interposition is that `stampMeta` runs `atStamp` BEFORE it asks the server for the
 * counters. ONCE — a latch, because the permit probes the same method at every boundary and a
 * rival that took the mailbox once cannot take it again.
 *
 * A `Proxy` rather than a spread: `ImapAdapter` is a class and `{ ...adapter }` would drop every
 * method onto an object `hasLeaseIo` then reports as leaseless — a fixture that measures a
 * composition no install has.
 */
function withStampHook(adapter: ImapAdapter, atStamp: () => Promise<void>): MailboxAdapter {
  let fired = false;
  const passthrough = (target: object, prop: string | symbol): unknown => {
    const v = Reflect.get(target, prop, target) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  };
  return new Proxy(adapter, {
    get(target, prop): unknown {
      if (prop !== "leaseIo") return passthrough(target, prop);
      return (identity: { installId: string; mailboxId: string }): LeaseIo => {
        const io = target.leaseIo(identity);
        return new Proxy(io, {
          get(t, p): unknown {
            if (p === "stampMeta" && typeof t.stampMeta === "function") {
              return async () => {
                if (!fired) { fired = true; await atStamp(); }
                return t.stampMeta!();
              };
            }
            return passthrough(t, p);
          },
        });
      };
    },
  }) as unknown as MailboxAdapter;
}

describe("the permit's baseline against a takeover that lands mid-stamp, on a real server", () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });
  const track = (w: World): World => {
    open.push(w.adapter);
    return w;
  };

  /**
   * THE CASE THE FINDING NAMES. B's press lands after A's claim was verified and before A's
   * counters are answered. The clock is held still and no write boundary is anywhere near the
   * hundredth, so neither of the permit's own bounds can be what refuses: what has to refuse is
   * the custody question the baseline is meant to answer.
   */
  it("does not admit a write after a takeover landed before this install's counters were read", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));
    const b = track(await makeWorld(cfg, "ohmail-cloud:test", "cloud"));

    const t0 = new Date();
    let seizedOk = false;
    const hooked = withStampHook(a.adapter, async () => {
      const seized = await readMailboxLease({
        adapter: b.adapter, self: b.self, mailboxId, now: new Date(t0.getTime() + 1_000),
        hasRequestKey: false, takeover: { authorizedAt: t0, intent: "takeover" }, onNonceMinted: () => undefined,
      });
      seizedOk = seized.organize;
    });

    /* EITHER END IS AN ADMISSION. A gate that discovers the takeover while recording its baseline
       refuses here; one that does not hands back a permit, and then the very next write boundary
       is where the invariant has to hold. The case asks one question of both shapes. */
    const taken = await acquireLeasePermit({
      adapter: hooked, self: a.self, mailboxId, hasRequestKey: false, ...new PermitClock(t0.getTime()).pair,
    }).then((permit) => ({ permit, err: null as unknown }), (err: unknown) => ({ permit: null, err }));

    expect(seizedOk, "the fixture's hand-over did not land, so this case measures nothing").toBe(true);

    const refusal = taken.permit === null
      ? taken.err
      : await assertMayWriteToMailbox({ lease: taken.permit }, "move").then(() => null, (err: unknown) => err);

    expect(refusal, "this install was admitted to write to a mailbox somebody else now organizes")
      .toBeInstanceOf(OrganizerStandDownError);
    expect((refusal as OrganizerStandDownError).reason).toBe("organized_elsewhere:cloud");
    /* THE PERMIT BOUND IS A BACKSTOP, ASSERTED AS ONE. The clock never moved and at most one write
       boundary was spent, so neither the TTL nor the write count can have produced the refusal —
       which is the whole point: a bound that ends the overlap afterwards is not the same thing as
       not overlapping. */
    expect(taken.permit?.writesSinceRead ?? 0).toBeLessThan(PERMIT_WRITES_PER_RECHECK);
  });

  /**
   * THE POSITIVE CONTROL, THROUGH THE SAME WRAPPER. Nobody contests the mailbox, the hook does
   * nothing, and this install is admitted and stays admitted — so a red above is the takeover and
   * never the interposition.
   */
  it("admits an uncontested organizer through the same wrapper, and keeps admitting it", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));

    const t0 = new Date();
    const hooked = withStampHook(a.adapter, async () => undefined);
    const permit = await acquireLeasePermit({
      adapter: hooked, self: a.self, mailboxId, hasRequestKey: false, ...new PermitClock(t0.getTime()).pair,
    });
    for (let i = 0; i < 10; i++) await assertMayWriteToMailbox({ lease: permit }, "move");

    expect(permit.reads, "an uncontested folder was read again").toBe(1);
    expect(permit.revoked).toBe(false);
    expect(permit.writesSinceRead).toBe(10);
  });

  /**
   * AND THE CLAIM IS THE ONE IN THE FOLDER. The takeover above is a real APPEND and EXPUNGE
   * against the one medium both installs share, so the folder is asked directly rather than the
   * fixture's own bookkeeping: `ohmail/_meta` holds B's claim and none of A's.
   */
  it("leaves the folder holding the winner's claim alone", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "this-mac", "local"));
    const b = track(await makeWorld(cfg, "ohmail-cloud:test", "cloud"));

    const t0 = new Date();
    const hooked = withStampHook(a.adapter, async () => {
      await readMailboxLease({
        adapter: b.adapter, self: b.self, mailboxId, now: new Date(t0.getTime() + 1_000),
        hasRequestKey: false, takeover: { authorizedAt: t0, intent: "takeover" }, onNonceMinted: () => undefined,
      });
    });
    await acquireLeasePermit({
      adapter: hooked, self: a.self, mailboxId, hasRequestKey: false, ...new PermitClock(t0.getTime()).pair,
    }).catch(() => undefined);

    const io = b.adapter.leaseIo({ installId: b.self.installId, mailboxId });
    const raw = await io.listClaims();
    const holders = raw
      .map((m) => /^X-Ohmail-Install-Id:\s*(.+)$/mi.exec(m.raw)?.[1]?.trim())
      .filter((v): v is string => v !== undefined);
    expect(holders, `${META_FOLDER} does not hold exactly the winner's claim`).toEqual(["ohmail-cloud:test"]);
  });
});
