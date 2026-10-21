import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, eml, probeCondstore, seedInbox, waitFor } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

describe("ImapAdapter.watch (GreenMail IDLE)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("fires onSignal when a new message arrives in INBOX", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();

    let fired = 0;
    const stop = await adapter.watch(() => { fired += 1; });

    // deliver a message via a second connection
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    await c.append("INBOX", eml({ from: "ping@x.example", subject: "idle", messageId: "idle1@x" }));
    await c.logout();

    await waitFor(() => fired > 0, 28000);
    expect(fired).toBeGreaterThan(0);
    await stop();
  }, 32000);
});

/**
 * THE DOORBELL AFTER A DELETE. On a QRESYNC server (Dovecot) an INBOX expunge arrives as VANISHED,
 * which imapflow 1.7.8 never counted against `exists`: the next arrival's EXISTS equalled the stale
 * count and was dropped, so `onSignal` never rang. Our own filing and another client's delete, on
 * Dovecot and on GreenMail (EXPUNGE, the control).
 */
function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok },
];
const RING_MS = 5_000;

for (const server of SERVERS) {
  describe.skipIf(!server.enabled)(`ImapAdapter.watch after a delete (${server.name})`, () => {
    const open: Array<() => Promise<unknown>> = [];
    afterEach(async () => { for (const c of open.splice(0).reverse()) await c().catch(() => undefined); });

    const flow = async (cfg: ImapConfig): Promise<ImapFlow> => {
      const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
      await c.connect();
      return c;
    };
    const deliver = async (cfg: ImapConfig, tag: string): Promise<void> => {
      const c = await flow(cfg);
      await c.append("INBOX", eml({ from: "ping@x.example", subject: tag, messageId: `${tag}-${randomUUID()}@x` }));
      await c.logout();
    };
    const serverCount = async (cfg: ImapConfig): Promise<number> => {
      const c = await flow(cfg);
      try { return (await c.status("INBOX", { messages: true })).messages ?? -1; } finally { await c.logout(); }
    };
    const clientCount = (adapter: ImapAdapter): number => {
      const mb = (adapter as unknown as { client: ImapFlow }).client.mailbox;
      return mb ? mb.exists : -1;
    };

    it("after filing the one INBOX mail, the next arrival rings and the count is the server's", async () => {
      const cfg = server.config();
      const adapter = new ImapAdapter(cfg);
      open.push(() => adapter.close());
      await adapter.connect();
      await adapter.ensureFolders(FIXTURE_DOOR);
      const seed = await seedInbox(cfg, `seed-${randomUUID()}@x`);
      let fired = 0;
      const stop = await adapter.watch(() => { fired += 1; });
      open.push(stop);
      await adapter.move({ folder: "INBOX", ref: seed.ref }, "ohmail/News", FIXTURE_DOOR);
      await adapter.rearmWatch();
      expect(clientCount(adapter), "the client's INBOX count after the filing").toBe(await serverCount(cfg));
      fired = 0;
      await deliver(cfg, "after-filing");
      await waitFor(() => fired > 0, RING_MS).catch(() => undefined);
      expect(fired, "the arrival after the filing did not ring").toBeGreaterThan(0);
    }, 30_000);

    it("after another client deletes the one INBOX mail, the next arrival rings", async () => {
      const cfg = server.config();
      await seedInbox(cfg, `seed-${randomUUID()}@x`);
      const adapter = new ImapAdapter(cfg);
      open.push(() => adapter.close());
      await adapter.connect();
      let fired = 0;
      const stop = await adapter.watch(() => { fired += 1; });
      open.push(stop);
      const other = await flow(cfg);
      await other.mailboxOpen("INBOX");
      await other.messageDelete("1:*");
      await other.logout();
      await waitFor(() => clientCount(adapter) === 0, RING_MS).catch(() => undefined);
      fired = 0;
      await deliver(cfg, "after-delete");
      await waitFor(() => fired > 0, RING_MS).catch(() => undefined);
      expect(fired, "the arrival after the other client's delete did not ring").toBeGreaterThan(0);
    }, 30_000);
  });
}
