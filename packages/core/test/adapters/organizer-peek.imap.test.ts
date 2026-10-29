import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import {
  DEFAULT_STALE_AFTER_MS,
  META_FOLDER,
  formatClaim,
  readLeasePeek,
  runLeaseGate,
  type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { rigAppendDate } from "../../../../test/support/rig-append-date.js";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * A PEEK MUST NOT WRITE. Proven against a real IMAP server, observed with a SECOND client.
 *
 * ── WHY THIS IS THE TEST THAT MATTERS ─────────────────────────────────────────────────────
 *
 * The organizer lease's whole job is that exactly one install organizes a mailbox. A surface that
 * merely SHOWS who holds it is one careless line away from becoming an organizer itself: the gate
 * creates `ohmail/_meta` before it decides anything, and against an empty folder it answers
 * "organize" and appends a claim. So a preview built on the gate would, on being opened, quietly
 * stand the user's own machine down for the whole staleness window — and would leave no trace
 * except a mailbox that stopped being organized.
 *
 * Asserting "the peek returned the right state" cannot catch that. What catches it is asserting
 * the SERVER is unchanged afterwards, through a connection the peek does not own: the folder list,
 * and the exact set of UIDs in `ohmail/_meta`.
 *
 * ── AND WHY THE GATE IS RUN IN THE SAME FILE ──────────────────────────────────────────────
 *
 * A "nothing changed" assertion against a mailbox nothing could have changed proves nothing. The
 * positive control runs the REAL gate over the same fixture and watches the same observations move
 * — the folder appear, the UID set change. That is what makes the peek's stillness evidence.
 *
 * GreenMail and Dovecot, because this is protocol behaviour: an absent folder, an EMPTY folder
 * (`1:*` is not a valid messageset and Dovecot refuses the command outright where GreenMail
 * tolerates it), and the hierarchy delimiter, which is `.` on both of these and `/` elsewhere.
 */

const NOW = new Date();

interface Server {
  name: string;
  config: () => ImapConfig;
  enabled: boolean;
  /** Why it is not enabled, for the skipped test's NAME. Empty when it is. */
  why: string;
}

/** A fresh Dovecot user per test — the static passdb accepts any name with this password. */
function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST,
    port: CONDSTORE_PORT,
    secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

/* DETECTED, NOT DECLARED. This row read `Boolean(process.env.IMAP_CONDSTORE)` and the comment
 * called it "opt-in … wherever it is available" — but nothing sets that variable, so "available"
 * never once meant "running". Five peek cases sat skipped against a Dovecot that had been up for
 * a day. `probeCondstore` asks the server instead, and keeps the variable as a force-on override. */
const CONDSTORE = await probeCondstore();

const SERVERS: Server[] = [
  { name: "GreenMail", config: greenmailConfig, enabled: true, why: "" },
  // The STRICT server, and the one that found the empty-mailbox FETCH defect in the gate — so the
  // peek, which does the same FETCH, runs against it whenever it is actually there.
  {
    name: "Dovecot", config: dovecotConfig,
    enabled: CONDSTORE.ok, why: CONDSTORE.ok ? "" : CONDSTORE.why,
  },
];

const open: Array<{ close: () => Promise<unknown> }> = [];

async function adapterFor(cfg: ImapConfig): Promise<ImapAdapter> {
  const a = new ImapAdapter(cfg);
  await a.connect();
  open.push(a);
  return a;
}

/** The independent observer. Never the connection under test. */
async function witness(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  open.push({ close: () => c.logout().catch(() => c.close()) });
  return c;
}

/** What the server says, read by somebody who did not do the thing under test. */
async function observe(w: ImapFlow, path: string): Promise<{ folderExists: boolean; uids: number[] }> {
  const list = await w.list();
  const folderExists = list.some((f) => f.path === path);
  if (!folderExists) return { folderExists, uids: [] };
  const lock = await w.getMailboxLock(path);
  try {
    const box = w.mailbox;
    if (typeof box === "object" && box !== null && box.exists === 0) return { folderExists, uids: [] };
    const uids: number[] = [];
    for await (const m of w.fetch("1:*", { uid: true }, { uid: false })) uids.push(m.uid);
    return { folderExists, uids: uids.sort((a, b) => a - b) };
  } finally {
    lock.release();
  }
}

const foreignSelf = (installId: string): LeaseSelf => ({
  installId, kind: "local", displayName: `${installId} machine`, lastNonce: null,
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => { /* already down */ });
});

for (const server of SERVERS) {
  /* The absence is REPORTED, not inferred from a count — see the same pair in
   * `imap.changes.fastpath.test.ts`. */
  if (!server.enabled) {
    /* See the twin in `imap.changes.fastpath.test.ts`: no reporter here prints a skipped test's
     * name, so the reason is printed as well as named. */
    console.warn(`\n[condstore] SKIPPING the organizer peek against ${server.name} — ${server.why}\n`);
    describe(`organizer peek — writes nothing (${server.name})`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
  }

  describe.skipIf(!server.enabled)(`organizer peek — writes nothing (${server.name})`, () => {
    it("an ABSENT ohmail/_meta reports `none` AND IS STILL ABSENT afterwards", async () => {
      const cfg = server.config();
      const adapter = await adapterFor(cfg);
      const w = await witness(cfg);
      const path = adapter.toServerPath(META_FOLDER);

      const before = await observe(w, path);
      expect(before.folderExists).toBe(false);

      const peek = await readLeasePeek({ io: adapter.leasePeekIo(), now: NOW });
      expect(peek.state).toBe("none");
      expect(peek.holders).toEqual([]);

      // THE ASSERTION THIS FILE EXISTS FOR. `runLeaseGate` would have created this folder before
      // it decided anything — creating a folder in somebody's mailbox to answer a question about
      // it, and changing the answer for the next reader from "no folder" to "empty folder".
      const after = await observe(w, path);
      expect(after.folderExists).toBe(false);
    });

    it("POSITIVE CONTROL — the real gate DOES create the folder and DOES append a claim", async () => {
      // Without this, "nothing changed" above is indistinguishable from a mailbox nothing could
      // change. This runs the gate over the same fixture and watches both observations move.
      const cfg = server.config();
      const adapter = await adapterFor(cfg);
      const w = await witness(cfg);
      const path = adapter.toServerPath(META_FOLDER);

      expect((await observe(w, path)).folderExists).toBe(false);

      const result = await runLeaseGate({ capabilities: [], io: adapter.leaseIo(TEST_META_ID), self: foreignSelf("gate-1"), now: NOW });
      expect(result.verdict.verdict).toBe("organize");

      const after = await observe(w, path);
      expect(after.folderExists).toBe(true);
      expect(after.uids).toHaveLength(1);
    });

    it("a LIVE foreign claim reads as `held`, names the machine, and the folder is untouched", async () => {
      const cfg = server.config();
      // A foreign organizer, written by its own gate against its own connection — a fixture
      // appended by hand would not prove the peek reads what an organizer actually writes.
      const foreign = await adapterFor(cfg);
      await runLeaseGate({ capabilities: [], io: foreign.leaseIo(TEST_META_ID), self: foreignSelf("laptop-7"), now: NOW });

      const reader = await adapterFor(cfg);
      const w = await witness(cfg);
      const path = reader.toServerPath(META_FOLDER);
      const before = await observe(w, path);
      expect(before.uids).toHaveLength(1);

      const peek = await readLeasePeek({ io: reader.leasePeekIo(), now: NOW });
      expect(peek.state).toBe("held");
      expect(peek.holders).toHaveLength(1);
      expect(peek.holders[0]!.kind).toBe("local");
      expect(peek.holders[0]!.displayName).toBe("laptop-7 machine");
      expect(peek.holders[0]!.fresh).toBe(true);

      // Same UIDs, same count. A renew is append-then-expunge, so a peek that renewed would show
      // one message here too — the UID is what tells the two apart.
      expect(await observe(w, path)).toEqual(before);
    });

    it("a claim nobody renewed reads as `stopped`, and is NOT expunged by the read", async () => {
      const cfg = server.config();
      const owner = await adapterFor(cfg);
      const stale = rigAppendDate(DEFAULT_STALE_AFTER_MS + 60_000, NOW.getTime());
      const io = owner.leaseIo(TEST_META_ID);
      await io.ensureMetaFolder();

      const reader = await adapterFor(cfg);
      const w = await witness(cfg);
      const path = reader.toServerPath(META_FOLDER);
      /* ── BACK-DATING A HEARTBEAT AGAINST A REAL SERVER FORGES A BROKEN CLOCK ──────────────
       *
       * `io.appendClaim` lets the server stamp INTERNALDATE with its own now, so a record whose
       * heartbeat reads an hour ago and whose INTERNALDATE reads this second is not a claim
       * nobody renewed — it is a machine whose clock is an hour slow, which is a different
       * fixture and, since readers age by the server's stamp, a different verdict. A claim
       * nobody renewed has an OLD INTERNALDATE, and IMAP's APPEND takes the date-time for
       * exactly this. The control for the forged shape is the case below.
       */
      await w.append(path, formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "crashed-mac", kind: "local", displayName: "Kitchen Mac",
        heartbeat: stale, claimedAt: stale, nonce: randomUUID(),
      }), ["\\Seen"], stale);
      const before = await observe(w, path);
      expect(before.uids).toHaveLength(1);

      const peek = await readLeasePeek({ io: reader.leasePeekIo(), now: NOW });
      expect(peek.state).toBe("stopped");
      expect(peek.holders[0]!.displayName).toBe("Kitchen Mac");
      expect(peek.holders[0]!.fresh).toBe(false);

      // THE STAND-DOWN PATH OF THE GATE RELEASES — it expunges claims matching its own install id.
      // A peek that ran the gate with a fabricated identity could therefore DELETE the very claim
      // it was asked to report on, and the second read would then say `none`.
      expect(await observe(w, path)).toEqual(before);
      expect((await readLeasePeek({ io: reader.leasePeekIo(), now: NOW })).state).toBe("stopped");
    });

    /**
     * THE CONTROL FOR THE CASE ABOVE, and the reason its APPEND states a date.
     *
     * The same claim, the same stale heartbeat, appended the ordinary way so the server stamps
     * INTERNALDATE with its own now — which is a writer whose clock is an hour slow, still
     * renewing. It reads as HELD, and that is the fix rather than a defect: a live organizer whose
     * clock is wrong is not residue, and treating it as residue is how two installs come to file
     * one mailbox. Without this case the one above would pass for a build that ignored the server's
     * stamp entirely.
     */
    it("but a stale heartbeat the server stamped JUST NOW is a slow clock, and reads as `held`", async () => {
      const cfg = server.config();
      const owner = await adapterFor(cfg);
      const stale = new Date(NOW.getTime() - DEFAULT_STALE_AFTER_MS - 60_000);
      const io = owner.leaseIo(TEST_META_ID);
      await io.ensureMetaFolder();
      await io.appendClaim(formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "slow-mac", kind: "local", displayName: "Slow Mac",
        heartbeat: stale, claimedAt: stale, nonce: randomUUID(),
      }));

      const reader = await adapterFor(cfg);
      const peek = await readLeasePeek({ io: reader.leasePeekIo(), now: NOW });
      expect(peek.state, "the server's own stamp was not read, so a live organizer looked dead")
        .toBe("held");
      expect(peek.holders[0]!.fresh).toBe(true);
    });

    it("an EMPTY ohmail/_meta reads as `none` without the server refusing the FETCH", async () => {
      // The folder exists and holds nothing, which is the state a released claim leaves behind.
      // `1:*` is not a valid messageset there; Dovecot refuses the command outright. The gate was
      // shipped without this defence and every genuinely fresh mailbox was unorganizable.
      const cfg = server.config();
      const owner = await adapterFor(cfg);
      await owner.leaseIo(TEST_META_ID).ensureMetaFolder();

      const reader = await adapterFor(cfg);
      const peek = await readLeasePeek({ io: reader.leasePeekIo(), now: NOW });
      expect(peek.state).toBe("none");
      expect(peek.unreadable).toBe(0);
    });
  });
}
