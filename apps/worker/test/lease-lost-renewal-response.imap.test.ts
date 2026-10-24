import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import {
  META_FOLDER, formatClaim, type LeaseIo, type LeaseSelf,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap-types";
import {
  LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit, assertMayWriteToMailbox,
  releaseMailboxClaim,
} from "../src/lease.js";
import { greenmailPorts } from "./_greenmail-ports.js";
import { FIXTURE_DOOR } from "./_door.js";
import { PermitClock } from "./_permit-clock.js";

/**
 * ═══ AN INSTALL RECOGNISES ITS OWN CLAIM WHATEVER HAPPENED TO THE RESPONSE ════════════════════
 *
 * A renewal APPENDs and the response is lost. The write COMMITTED — the claim is in the folder —
 * but the caller only ever learned its own new nonce from the answer, so it kept the previous one.
 * The next gate then read a live claim wearing this install's id under a nonce it could not
 * account for, which is the clone defence's exact trigger: it stood the RUNNING install down and
 * preserved the orphan, and the orphan then refused the stop that would have cleared it. The
 * person's mail stopped being organized and nothing they could press fixed it.
 *
 * The lost response is INJECTED at the IO seam and the server is real: GreenMail cannot be made
 * hostile, and it does not need to be — the append lands on it exactly as it lands in production,
 * and only the answer is taken away. Everything else here is the product: the worker's permit, its
 * gate, its release.
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

async function makeWorld(cfg: ImapConfig, installId: string): Promise<World> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  await adapter.ensureFolders(FIXTURE_DOOR);
  return {
    adapter,
    self: { installId, kind: "cloud", displayName: `${installId}'s machine`, lastNonce: null },
  };
}

/** GreenMail's hierarchy delimiter is `.`, so the canonical path is spelled the server's way. */
const SERVER_META = META_FOLDER.split("/").join(".");

/**
 * THE ANSWER TAKEN AWAY, AND NOTHING ELSE. `appendClaim` delegates to the live connection — the
 * claim really lands in `ohmail/_meta` — and then throws, which is what a dropped response looks
 * like to every caller above it. Armed by a latch so exactly one renewal loses its answer.
 */
function withLostAppendResponse(adapter: ImapAdapter, arm: { lose: boolean }): MailboxAdapter {
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
            if (p !== "appendClaim") return passthrough(t, p);
            return async (raw: string): Promise<void> => {
              await t.appendClaim(raw);
              if (!arm.lose) return;
              arm.lose = false;
              throw new Error("the connection dropped before the server's answer arrived");
            };
          },
        });
      };
    },
  }) as unknown as MailboxAdapter;
}

/** Every claim in the folder, as (install id, nonce) pairs — the folder asked directly. */
async function claimsIn(cfg: ImapConfig): Promise<{ install: string; nonce: string }[]> {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(SERVER_META);
    try {
      const out: { install: string; nonce: string }[] = [];
      for await (const m of c.fetch("1:*", { headers: true })) {
        /* HEADERS ONLY, and only the two fields this file asks about. A wire read that printed
           what it fetched would put a fixture's login in a transcript; this reads two values and
           never the block they came in. */
        const raw = m.headers?.toString("utf8") ?? "";
        const install = /^X-Ohmail-Install-Id:\s*(.+)$/mi.exec(raw)?.[1]?.trim();
        const nonce = /^X-Ohmail-Nonce:\s*(.+)$/mi.exec(raw)?.[1]?.trim();
        if (install !== undefined && nonce !== undefined) out.push({ install, nonce });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

describe("a renewal whose response never arrived, on a real server", () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });
  const track = (w: World): World => {
    open.push(w.adapter);
    return w;
  };

  /**
   * THE CASE THE FINDING NAMES. One install, one mailbox, nobody else anywhere near it: the
   * renewal commits, its answer is lost, and the very next gate must go on organizing. A clock
   * that moves past the permit's TTL is what makes the next boundary re-read; nothing else here
   * is contrived.
   */
  it("keeps organizing after its own renewal's answer was lost", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "ohmail-cloud:test"));
    const arm = { lose: false };
    const hooked = withLostAppendResponse(a.adapter, arm);

    const t = new PermitClock(Date.now());
    const permit = await acquireLeasePermit({
      adapter: hooked, self: a.self, mailboxId, hasRequestKey: false,
      ...t.pair, ttlMs: 1_000,
    });
    await assertMayWriteToMailbox({ lease: permit }, "move");

    // THE RENEWAL WHOSE ANSWER IS LOST. Past the TTL, so the boundary re-reads and renews.
    arm.lose = true;
    t.advance(5_000);
    const lost = await assertMayWriteToMailbox({ lease: permit }, "move").then(() => null, (e: unknown) => e);
    expect(lost, "the fixture did not take an answer away, so this case measures nothing")
      .toBeInstanceOf(LeaseUnavailableError);
    expect(permit.revoked, "an unreadable lease is not a stand-down").toBe(false);
    const written = await claimsIn(cfg);
    expect(written.length, "the renewal that lost its answer did not land, so nothing is at stake")
      .toBe(2);

    // AND THE NEXT BOUNDARY. The folder holds a claim this install wrote and has never been told
    // about; reading it as a stranger's is what stopped somebody's mail.
    t.advance(5_000);
    const after = await assertMayWriteToMailbox({ lease: permit }, "move").then(() => null, (e: unknown) => e);
    expect(after, "this install was stood down by a claim it had written itself").toBeNull();
    expect(permit.revoked).toBe(false);
  });

  /**
   * THE POSITIVE CONTROL, AND IT IS THE INVARIANT ITSELF. A live claim wearing this install's id
   * under a nonce this process never minted is a restored copy of us — two live writers — and it
   * still stands this install down. The fix widens what we recognise as our own by exactly one
   * value, and this is the arm that says it did not widen it to "anything with my id".
   */
  it("still stands down against a live claim wearing its id under a nonce it never minted", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "ohmail-cloud:test"));

    const t = new PermitClock(Date.now());
    const permit = await acquireLeasePermit({
      adapter: a.adapter, self: a.self, mailboxId, hasRequestKey: false,
      ...t.pair, ttlMs: 1_000,
    });
    await assertMayWriteToMailbox({ lease: permit }, "move");

    // THE CLONE: our install id, our display name, a nonce nothing in this process ever wrote.
    const c = new ImapFlow({
      host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
    });
    await c.connect();
    try {
      await c.append(SERVER_META, formatClaim({
        installId: a.self.installId, kind: "cloud", displayName: "a restored copy",
        heartbeat: new Date(t.ms + 4_000), claimedAt: new Date(t.ms + 4_000),
        nonce: randomUUID(), protocol: 1, authorizedAt: null, intent: "takeover",
        capabilities: [],
      }), ["\\Seen"]);
    } finally {
      await c.logout();
    }

    t.advance(5_000);
    const refused = await assertMayWriteToMailbox({ lease: permit }, "move").then(() => null, (e: unknown) => e);
    expect(refused, "the clone defence stopped biting").toBeInstanceOf(OrganizerStandDownError);
    expect(permit.revoked).toBe(true);
  });

  /**
   * AND THE ORPHAN DOES NOT OUTLIVE THE INSTALL THAT WROTE IT. A claim left by a lost answer is
   * this install's, so the person's "stop organizing here" clears it and the mailbox is free for
   * their other machine at once — rather than standing until it ages out, which is the second half
   * of what this defect cost.
   */
  it("releases the claim its own lost answer left behind", async () => {
    const cfg = cfgOf();
    const mailboxId = randomUUID();
    const a = track(await makeWorld(cfg, "ohmail-cloud:test"));
    const arm = { lose: false };
    const hooked = withLostAppendResponse(a.adapter, arm);

    const t = new PermitClock(Date.now());
    const permit = await acquireLeasePermit({
      adapter: hooked, self: a.self, mailboxId, hasRequestKey: false,
      ...t.pair, ttlMs: 1_000,
    });
    arm.lose = true;
    t.advance(5_000);
    await assertMayWriteToMailbox({ lease: permit }, "move").catch(() => undefined);
    expect((await claimsIn(cfg)).length, "the fixture left nothing to release").toBe(2);

    const removed = await releaseMailboxClaim(
      a.adapter, a.self.installId, mailboxId, permit.names.nonce,
      { now: new Date(t.ms), mintedNonces: permit.names.mintedNonces },
    );
    expect(removed, "the claim this install's own lost answer left behind was not released").toBe(2);
    expect(await claimsIn(cfg), `${META_FOLDER} still holds a claim nobody is behind`).toEqual([]);
  });
});
