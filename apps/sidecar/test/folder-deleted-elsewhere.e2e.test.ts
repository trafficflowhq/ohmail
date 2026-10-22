import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { mailboxes, messages } from "@trafficflow/db";
import { serviceUp } from "@trafficflow/db/testing";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE DESKTOP DOOR: A FOLDER DELETED IN ANOTHER MAIL APP WHILE THE APP WAS CLOSED LEAVES WITH ITS
 * LETTERS after the next launch. The engine as the shell runs it, one data directory across two
 * launches, reader and organizer, over Dovecot: once a session has read a folder, GreenMail ends
 * the connection that deletes it. Mutation: drop the by-name question in `changesSince` and the
 * filed letter is still stored and found.
 */

const HOST = process.env.IMAP_CONDSTORE_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_CONDSTORE_PORT ?? 3144);
const PASS = process.env.IMAP_CONDSTORE_PASS ?? "testpass-password";

function eml(o: { messageId: string; from: string; to: string; subject: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Date: Sun, 27 Sep 2026 04:30:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "the letter",
  ].join("\r\n");
}

/* The run's one probe (test/setup/services.global.ts); self-gated, as the SQLite run starts no Dovecot. */
const dovecot = serviceUp("dovecot", `${HOST}:${PORT}`);
const absent = dovecot.up ? "" : ` (SKIPPED: ${dovecot.why})`;

const open: Sidecar[] = [];
const dirs: string[] = [];
const clients: ImapFlow[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
  for (const c of clients.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the desktop door: a folder deleted in another mail app while the app was closed", () => {
  for (const role of ["reader", "organizer"] as const) {
    it.skipIf(absent !== "")(`${role}: its letters are gone from the store and from search after the next launch${absent}`, async () => {
      const cfg = { host: HOST, port: PORT, secure: false as const, auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: PASS } };
      const me = cfg.auth.user;
      const c = new ImapFlow({ ...cfg, logger: false });
      await c.connect();
      clients.push(c);
      for (const p of ["Sent", "Trash", "Projects"]) await c.mailboxCreate(p).catch(() => undefined);
      await c.append("INBOX", eml({ messageId: "stays@x", from: "anna@x.example", to: me, subject: "r9 still on the server" }));
      await c.append("Projects", eml({ messageId: "filed@x", from: "anna@x.example", to: me, subject: "r9 filed away" }));

      const dataDir = await freshDataDir("ohmail-folder-deleted-elsewhere-");
      dirs.push(dataDir);
      const keks = { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) };
      const launch = async (): Promise<Sidecar> => {
        const s = await createSidecar({ dataDir, imap: cfg, address: me, displayName: "This Mac", keks, pollIntervalMs: 60 * 60 * 1000 });
        open.push(s);
        if (role === "organizer") await grantOrganizeConsent(s);
        await s.start();
        await s.syncUntilQuiet();
        return s;
      };
      const rowOf = async (s: Sidecar, header: string) => (await s.db.select({ id: messages.id, deletedAt: messages.deletedAt })
        .from(messages).where(eq(messages.messageIdHeader, header)))[0];
      const searched = async (s: Sidecar): Promise<string[]> => {
        const res = await s.handle(new Request("http://sidecar/search?q=r9", { headers: { authorization: `Bearer ${s.sessionToken}` } }));
        expect(res.status).toBe(200);
        return ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
      };

      const first = await launch();
      const [mb] = await first.db.select({ role: mailboxes.organizerRole }).from(mailboxes);
      expect(mb?.role, "the precondition: the install runs in the role under test").toBe(role);
      const filed = (await rowOf(first, "filed@x"))!.id;
      expect(await searched(first)).toContain(filed);
      await first.stop();
      open.splice(open.indexOf(first), 1);

      const other = new ImapFlow({ ...cfg, logger: false });
      await other.connect();
      clients.push(other);
      await other.mailboxDelete("Projects");

      const second = await launch();
      expect((await rowOf(second, "filed@x"))!.deletedAt, "the letter in the deleted folder is still live").not.toBeNull();
      expect(await searched(second), "search still finds the letter in the deleted folder").not.toContain(filed);
      const live = await second.db.select({ h: messages.messageIdHeader }).from(messages).where(isNull(messages.deletedAt));
      expect(live.map((r) => r.h), "a letter still on the server was taken").toEqual(["stays@x"]);
    }, 180_000);
  }
});
