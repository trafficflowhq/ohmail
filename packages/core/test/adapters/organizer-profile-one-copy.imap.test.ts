import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import {
  formatProfileMessage,
  makeProfileDoc,
  tidyOrganizerProfile,
  writeOrganizerProfile,
  type OrganizerProfilePayload,
} from "../../src/adapters/organizer-profile.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { metaRelay, type MetaRelay, type MetaRelayOptions } from "./_meta-relay.js";

/**
 * ONE SETTINGS MESSAGE PER MAILBOX, on real servers. GreenMail and Dovecot, each direct
 * and through a relay that makes the server misbehave the way a provider does: every header SEARCH
 * answered with nothing (the iCloud shape), an EXPUNGE refused, no UIDPLUS. Writes go through a
 * real `ImapAdapter`; an independent connection straight to the server counts the settings
 * messages after each one. The relay counts what it rewrote, so a green through it is a relay
 * that fired. The in-process twins are `organizer-profile-presence.test.ts`.
 */

/* Every case is several real sessions (adapter, witness, relay) and five writes, no wait of its own:
   2.6-4.4 s each on the CI VMs, GreenMail the slower. 6x the slowest, on the ladder, for the file. */
vi.setConfig({ testTimeout: 30_000 });

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
});

async function flow(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  open.push({ close: () => c.logout().catch(() => c.close()) });
  return c;
}

function payload(tag: string): OrganizerProfilePayload {
  return { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null };
}

/** Creates `ohmail/_meta` through the adapter and returns the server path the witness lists. */
async function metaPathOf(adapter: ImapAdapter, witness: ImapFlow): Promise<string> {
  await adapter.profileIo({ installId: `seed-${randomUUID()}`, mailboxId: "one-copy" }).ensureMetaFolder();
  const row = (await witness.list()).find((f) => /(^|[./])ohmail[./]_meta$/.test(f.path));
  if (!row) throw new Error("ensureMetaFolder created no ohmail/_meta the witness can list");
  return row.path;
}

/**
 * THE WITNESS READS THROUGH A FRESH CONNECTION EACH TIME. A session learns of another connection's
 * EXPUNGE only at a command that may carry it, never during a FETCH (RFC 3501 §7.4.1), so a
 * long-lived witness on Dovecot went on listing removed copies and counted 0,0,1,2,3 over writes the
 * adapter had left at one each.
 */
async function witnessRead<T>(cfg: ImapConfig, path: string, read: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(path);
    try {
      return await read(c);
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** The witness's count: every message whose header block carries `X-Ohmail-Profile: 1`. */
async function settingsCount(cfg: ImapConfig, path: string): Promise<number> {
  return witnessRead(cfg, path, async (c) => {
    const box = c.mailbox;
    if (typeof box === "object" && box !== null && box.exists === 0) return 0;
    let n = 0;
    for await (const m of c.fetch("1:*", { uid: true, headers: ["X-Ohmail-Profile"] }, { uid: false })) {
      if (/^X-Ohmail-Profile:\s*1\s*$/mi.test(m.headers?.toString("utf8") ?? "")) n += 1;
    }
    return n;
  });
}

async function unseenOf(cfg: ImapConfig, path: string): Promise<number> {
  return witnessRead(cfg, path, async (c) => (await c.status(path, { unseen: true })).unseen ?? -1);
}

/** Every message in `_meta` by its bytes, for the byte-identity check. */
async function sourcesOf(cfg: ImapConfig, path: string): Promise<Map<number, string>> {
  return witnessRead(cfg, path, async (c) => {
    const out = new Map<number, string>();
    const box = c.mailbox;
    if (typeof box === "object" && box !== null && box.exists === 0) return out;
    for await (const m of c.fetch("1:*", { uid: true, source: true }, { uid: false })) {
      out.set(m.uid, m.source?.toString("utf8") ?? "");
    }
    return out;
  });
}

const STRANGER = "Subject: a stranger's note\r\nX-Note: kept\r\n\r\nnot ohmail's";

for (const server of SERVERS) {
  if (!server.enabled) {
    console.warn(`\n[condstore] SKIPPING one settings message against ${server.name} — ${server.why}\n`);
    describe(`one settings message on the wire (${server.name})`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
    continue;
  }

  const variants: Array<{ name: string; relay: MetaRelayOptions | null }> = [
    { name: "direct", relay: null },
    { name: "blind header search", relay: { blindHeaderSearch: true } },
  ];
  for (const variant of variants) {
    describe(`one settings message on the wire (${server.name}, ${variant.name})`, () => {
      async function endpoint(cfg: ImapConfig): Promise<{ at: ImapConfig; relay: MetaRelay | null }> {
        if (variant.relay === null) return { at: cfg, relay: null };
        const relay = await metaRelay({ host: cfg.host, port: cfg.port }, variant.relay);
        open.push(relay);
        return { at: { ...cfg, host: "127.0.0.1", port: relay.port }, relay };
      }

      it("five writes leave one settings message, seen, beside a stranger left byte-identical", async () => {
        const cfg = server.config();
        const { at, relay } = await endpoint(cfg);
        const adapter = new ImapAdapter(at);
        await adapter.connect();
        open.push(adapter);
        const witness = await flow(cfg);
        const path = await metaPathOf(adapter, witness);
        await witness.append(path, STRANGER, ["\\Seen"]);
        const strangerBefore = [...(await sourcesOf(cfg, path)).values()];

        const installId = `writer-${randomUUID()}`;
        const counts: number[] = [];
        for (let i = 1; i <= 5; i++) {
          const doc = makeProfileDoc(payload(`w${i}`), {
            updatedAt: new Date(Date.UTC(2026, 8, 28, 12, i, 0)), producer: { kind: "cloud", version: "test" },
          });
          const io = adapter.profileIo({ installId, mailboxId: "one-copy" });
          await writeOrganizerProfile({ io, doc, installId });
          counts.push(await settingsCount(cfg, path));
        }
        console.log(`MEASURE ${server.name} ${variant.name}: settings messages after writes 1..5 = ${counts.join(",")}`
          + (relay === null ? "" : `; header searches blinded ${relay.searchesBlinded}`));

        expect(counts, `${server.name} ${variant.name}: settings messages after each write`).toEqual([1, 1, 1, 1, 1]);
        expect(await unseenOf(cfg, path), "a settings message landed unseen").toBe(0);
        const after = [...(await sourcesOf(cfg, path)).values()];
        expect(after.filter((s) => s === strangerBefore[0]), "the stranger was touched").toHaveLength(1);
        if (relay !== null) expect(relay.searchesBlinded, "the profile still asks a header SEARCH").toBe(0);
      });
    });
  }

  /** A real adapter behind a relay with these modes, a witness straight to the server, and its path. */
  async function rig(modes: MetaRelayOptions): Promise<{ adapter: ImapAdapter; witness: ImapFlow; path: string; relay: MetaRelay; cfg: ImapConfig }> {
    const cfg = server.config();
    const relay = await metaRelay({ host: cfg.host, port: cfg.port }, modes);
    open.push(relay);
    const adapter = new ImapAdapter({ ...cfg, host: "127.0.0.1", port: relay.port });
    await adapter.connect();
    open.push(adapter);
    const witness = await flow(cfg);
    return { adapter, witness, path: await metaPathOf(adapter, witness), relay, cfg };
  }
  const docAt = (i: number) => makeProfileDoc(payload(`w${i}`), {
    updatedAt: new Date(Date.UTC(2026, 8, 28, 12, i, 0)), producer: { kind: "cloud", version: "test" },
  });

  describe(`on the lane servers (${server.name}): a 12 KB escaped line comes back byte for byte`, () => {
    it("a 2 000-character signature, escaped, is written, read back whole and parses to itself", async () => {
      const cfg = server.config();
      const adapter = new ImapAdapter(cfg);
      await adapter.connect();
      open.push(adapter);
      const witness = await flow(cfg);
      const path = await metaPathOf(adapter, witness);
      const installId = `writer-${randomUUID()}`;
      const signature = "Grüße aus Basel · ".repeat(120).slice(0, 2_000);
      const doc = makeProfileDoc({ ...payload("m1"), signature }, {
        updatedAt: new Date(Date.UTC(2026, 8, 28, 13, 0, 0)), producer: { kind: "cloud", version: "test" },
      });
      const sent = formatProfileMessage(doc, { installId });
      expect(sent.replace(/\r\n/g, ""), "a bare line ending in the message").not.toMatch(/[\r\n]/);
      const longest = Math.max(...sent.split("\r\n").map((l) => l.length));

      const r = await writeOrganizerProfile({ io: adapter.profileIo({ installId, mailboxId: "one-copy-m1" }), doc, installId });
      const back = [...(await sourcesOf(cfg, path)).values()].filter((src) => src.includes(installId));
      console.log(`MEASURE ${server.name}: longest line ${longest} octets; write ${JSON.stringify(r)}; copies ${back.length}`);

      expect(longest, "the fixture has no long line").toBeGreaterThan(10_000);
      expect(r).toEqual({ written: true, removed: 0 });
      expect(back, "the stored message is not the bytes written").toEqual([sent]);
    });
  });

  describe(`a server that refuses EXPUNGE (${server.name})`, () => {
    it("five writes never hold more than two settings messages; healed, the next pass leaves one", async () => {
      const { adapter, path, relay, cfg } = await rig({ blindHeaderSearch: true, refuseExpunge: true });
      const installId = `writer-${randomUUID()}`;
      const io = () => adapter.profileIo({ installId, mailboxId: "one-copy-t13" });
      const counts: number[] = [];
      for (let i = 1; i <= 5; i++) {
        await writeOrganizerProfile({ io: io(), doc: docAt(i), installId });
        counts.push(await settingsCount(cfg, path));
      }
      console.log(`MEASURE ${server.name} refused EXPUNGE: settings messages after writes 1..5 = ${counts.join(",")}; expunges refused ${relay.expungesRefused}`);
      expect(relay.expungesRefused, "the relay never refused an EXPUNGE").toBeGreaterThan(0);
      expect(Math.max(...counts), `settings messages after each write: ${counts.join(",")}`).toBeLessThanOrEqual(2);

      relay.heal("refuseExpunge");
      await tidyOrganizerProfile({ io: io(), installId });
      expect(await settingsCount(cfg, path)).toBe(1);
    });
  });

  describe(`a server without UIDPLUS (${server.name})`, () => {
    it("the append is found by its header, the replaced copy goes by plain EXPUNGE, and a stranger is byte-identical", async () => {
      const { adapter, witness, path, relay, cfg } = await rig({ blindHeaderSearch: true, stripUidplus: true });
      await witness.append(path, STRANGER, ["\\Seen"]);
      const before = [...(await sourcesOf(cfg, path)).values()];
      const installId = `writer-${randomUUID()}`;
      const counts: number[] = [];
      for (let i = 1; i <= 5; i++) {
        await writeOrganizerProfile({ io: adapter.profileIo({ installId, mailboxId: "one-copy-t14" }), doc: docAt(i), installId });
        counts.push(await settingsCount(cfg, path));
      }
      console.log(`MEASURE ${server.name} no UIDPLUS: settings messages after writes 1..5 = ${counts.join(",")}; rewrites ${relay.uidplusStripped}`);
      expect(relay.uidplusStripped, "the relay never stripped UIDPLUS").toBeGreaterThan(0);
      expect(counts).toEqual([1, 1, 1, 1, 1]);
      const after = [...(await sourcesOf(cfg, path)).values()];
      expect(after.filter((src) => src === before[0]), "the plain EXPUNGE took the stranger").toHaveLength(1);
    });
  });
}
