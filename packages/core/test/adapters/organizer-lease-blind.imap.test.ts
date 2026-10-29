import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { answerLeasePeek } from "../../src/adapters/organizer-lease.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { metaRelay, type MetaRelay } from "./_meta-relay.js";
import { INCUMBENT, INCUMBENT_NONCE, foreign600, gateOutcome } from "./_lease-fixtures.js";
import { rigAppendDates } from "../../../../test/support/rig-append-date.js";

/**
 * L17: THE LEASE PAST THE WINDOW ON REAL SERVERS (ARCH-LEASE-BLIND-SEARCH §5). GreenMail and
 * Dovecot, each direct and through a relay that rewrites every HEADER value in a SEARCH to one no
 * record carries — the server answers honestly and a header search finds nothing, the blind shape.
 * An independent connection seeds the ruling's folder (A's live claim first, its stale acks backdated) and counts
 * afterwards. Relayed at base the gate threw `renew_claim` and A's claims grew; now A renews in
 * place, the peek names A, the sweep takes the 100, and the lease and sweep ask no header SEARCH.
 */

const NO_RECORD_CARRIES = "ohmail-fixture-value-no-record-carries";

function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true, why: "" },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok, why: CONDSTORE.ok ? "" : CONDSTORE.why },
];

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c.close().catch(() => { /* already down */ });
  resetMetaMemos();
});

async function flow(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  open.push({ close: () => c.logout().catch(() => c.close()) });
  return c;
}

/** Creates `ohmail/_meta` through the adapter and returns the server path the witness lists. */
async function metaPathOf(adapter: ImapAdapter, witness: ImapFlow): Promise<string> {
  await adapter.leaseIo({ installId: `seed-${randomUUID()}`, mailboxId: "l17" }).ensureMetaFolder();
  const row = (await witness.list()).find((f) => /(^|[./])ohmail[./]_meta$/.test(f.path));
  if (!row) throw new Error("ensureMetaFolder created no ohmail/_meta the witness can list");
  return row.path;
}

/** A fresh witness connection per read: a long-lived one does not see another connection's EXPUNGE. */
async function claimsOf(cfg: ImapConfig, path: string, installId: string): Promise<number> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(path);
    try {
      let n = 0;
      for await (const m of c.fetch("1:*", { uid: true, headers: true }, { uid: false })) {
        const h = m.headers?.toString("utf8") ?? "";
        if (/^X-Ohmail-Lease: 1\s*$/mi.test(h) && new RegExp(`^X-Ohmail-Install-Id: ${installId}\\s*$`, "mi").test(h)) n += 1;
      }
      return n;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** The ruling's fixture plus its strays: A's live claim first, the stale acks backdated. */
async function seed650(witness: ImapFlow, path: string, now: Date): Promise<void> {
  const records = foreign600(now);
  const backdated = records.filter((r) => r.kind === "ack" && r.internalDate.getTime() < now.getTime() - 24 * 3_600_000);
  const dates = rigAppendDates(backdated.map((r) => now.getTime() - r.internalDate.getTime()), now.getTime());
  for (const r of records) {
    const i = backdated.indexOf(r);
    await witness.append(path, r.raw, ["\\Seen"], i >= 0 ? dates[i] : undefined);
  }
  for (let i = 0; i < 49; i++) await witness.append(path, `Subject: stray ${i}\r\n\r\n.\r\n`, ["\\Seen"]);
}

for (const server of SERVERS) {
  if (!server.enabled) {
    console.warn(`\n[condstore] SKIPPING the lease past the window against ${server.name} — ${server.why}\n`);
    describe(`L17: the lease past the window on the wire (${server.name})`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
    continue;
  }

  for (const arm of ["direct", "relayed"] as const) {
    describe(`L17: the lease past the window on the wire (${server.name}, ${arm})`, () => {
      it("A renews in place, the peek names A, the 100 stale acks go, and nothing asks a header SEARCH", async () => {
        const cfg = server.config();
        let relay: MetaRelay | null = null;
        let at = cfg;
        if (arm === "relayed") {
          relay = await metaRelay({ host: cfg.host, port: cfg.port }, { rewriteHeaderValues: NO_RECORD_CARRIES });
          open.push(relay);
          at = { ...cfg, host: "127.0.0.1", port: relay.port };
        }
        const creator = new ImapAdapter(cfg);
        await creator.connect();
        open.push(creator);
        const witness = await flow(cfg);
        const path = await metaPathOf(creator, witness);
        await seed650(witness, path, new Date());
        // The organizer connects to the folder as it stands; one held idle through the seeding times out.
        const adapter = new ImapAdapter(at);
        await adapter.connect();
        open.push(adapter);
        const identity = { installId: INCUMBENT, mailboxId: "l17" };

        const out = await gateOutcome({
          io: adapter.leaseIo(identity), now: new Date(), nonce: `a-${randomUUID()}`,
          self: { installId: INCUMBENT, kind: "local", displayName: "A", lastNonce: INCUMBENT_NONCE },
        });
        await out.result?.stamp;
        const claims = await claimsOf(cfg, path, INCUMBENT);
        const peek = await answerLeasePeek({ io: adapter.leasePeekIo(), now: new Date() });
        let swept = 0;
        for (let pass = 0; pass < 3; pass++) {
          swept += await adapter.requestOrganizerIo(identity).sweepStaleAcks!(new Date(Date.now() - 24 * 3_600_000));
        }
        console.log(`MEASURE ${server.name} ${arm}: gate ${out.word}; A claims ${claims}; peek ${peek.answer}; swept ${swept}`
          + (relay === null ? "" : `; header values rewritten ${relay.valuesRewritten}, literal values ${relay.literalValues}`));

        expect(out.word, "the incumbent could not renew past the window").toBe("organize");
        expect(claims, "the renewal left A's old claim beside the new one").toBe(1);
        expect(peek.answer === "held" ? peek.holder.installId : peek.answer, "the peek did not name A").toBe(INCUMBENT);
        expect(swept, "the stale acknowledgements were not swept").toBe(100);
        if (relay !== null) {
          expect(relay.literalValues, "a HEADER value went out as a literal the rewrite cannot see").toBe(0);
          expect(relay.valuesRewritten, "the lease or the sweep asked the server a header SEARCH").toBe(0);
        }
      }, 120_000);

      if (arm === "relayed") {
        /** RELAY BITES: the positive control that a header SEARCH through it finds nothing. */
        it("relay bites: a header SEARCH through the relay finds nothing, directly it finds the claim", async () => {
          const cfg = server.config();
          const relay = await metaRelay({ host: cfg.host, port: cfg.port }, { rewriteHeaderValues: NO_RECORD_CARRIES });
          open.push(relay);
          const adapter = new ImapAdapter(cfg);
          await adapter.connect();
          open.push(adapter);
          const witness = await flow(cfg);
          const path = await metaPathOf(adapter, witness);
          await witness.append(path, foreign600(new Date())[0]!.raw, ["\\Seen"]);

          const ask = async (c: ImapFlow): Promise<number[]> => {
            const lock = await c.getMailboxLock(path);
            try {
              const r = await c.search({ header: { "X-Ohmail-Lease": "1" } }, { uid: true });
              return Array.isArray(r) ? r : [];
            } finally { lock.release(); }
          };
          const direct = await ask(witness);
          const relayed = await ask(await flow({ ...cfg, host: "127.0.0.1", port: relay.port }));

          expect(direct, "the server does not answer the header search at all, so the control reads nothing").toHaveLength(1);
          expect(relayed, "the relay let the header search through").toEqual([]);
          expect(relay.valuesRewritten, "the relay rewrote nothing").toBeGreaterThan(0);
        }, 60_000);
      }
    });
  }
}
