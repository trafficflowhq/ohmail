import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serviceUp } from "@trafficflow/db/testing";

/**
 * A REAL SERVER THAT UNDER-DECLARES ONE MESSAGE (the set-aside walk's shape, on GreenMail).
 * GreenMail's RFC822.SIZE counts the body only, so a message whose header block is over 1 MiB and
 * whose body is a line arrives far past its declared size's ceiling: a `body_overrun`. Put in a
 * customer folder on its first pass, it is set aside once, the mailbox keeps syncing, and new
 * INBOX mail arrives. Box file: GreenMail on 127.0.0.1:3143, through box-lock.sh greenmail.
 */
const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_PORT ?? 3143);

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

const message = (user: string, subject: string, headerPad = 0): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", `To: <${user}>`, `Subject: ${subject}`,
  `Message-ID: <${subject}-${randomUUID()}@lane.test>`, "Date: Tue, 06 Oct 2026 10:00:00 +0000",
  ...(headerPad > 0 ? [`X-Padding: ${"a".repeat(headerPad)}`] : []),
  "Content-Type: text/plain; charset=utf-8", "", `Body of ${subject}.`, "",
].join("\r\n"), "utf8");

async function withClient<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

describe.skipIf(!SERVER_UP)(`a message GreenMail under-declares, in a customer folder — needs IMAP on ${HOST}:${PORT}`, () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("is set aside once, the mailbox keeps syncing, and new INBOX mail arrives", async () => {
    const user = `ov-${randomUUID()}@trafficflow.test`;
    const declared = await withClient(user, async (c) => {
      await c.mailboxCreate("Archive");
      await c.append("Archive", message(user, "archive-ordinary"));
      await c.append("Archive", message(user, "the-liar", 1_200_000));
      await c.append("INBOX", message(user, "inbox-first"));
      // THE PREMISE, read from the server: the liar's declared size is far under what it sends.
      const lock = await c.getMailboxLock("Archive");
      try {
        const sizes: number[] = [];
        for await (const m of c.fetch("1:*", { uid: true, size: true })) sizes.push(m.size ?? 0);
        return Math.max(...sizes);
      } finally { lock.release(); }
    });
    expect(declared * 1.5, "GreenMail declared the whole message, so nothing can overrun here").toBeLessThan(1_048_576);

    const dir = await freshDataDir("ohmail-overrun-greenmail-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lines: Array<{ event: string }> = [];
    const s: Sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: HOST, port: PORT, secure: false, auth: { user, pass: "test" } },
      machineName: "a desktop", pollIntervalMs: 600_000,
      log: (event: string) => { lines.push({ event }); },
    });
    cleanups.push(() => s.stop().catch(() => undefined));
    await grantOrganizeConsent(s);
    await s.start().catch(() => undefined);
    for (let i = 0; i < 3; i++) await s.syncUntilQuiet().catch(() => undefined);
    await withClient(user, (c) => c.append("INBOX", message(user, "inbox-new-mail")).then(() => undefined));
    for (let i = 0; i < 2; i++) await s.syncUntilQuiet().catch(() => undefined);

    const subjects = (await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject).sort();
    const conn = Object.values(s.connectionStates())[0]!;
    expect(lines.filter((l) => l.event === "mailbox_connection_unavailable").length,
      "the overrun never happened, so this cell measured nothing").toBeGreaterThanOrEqual(1);
    expect(subjects).toEqual(["archive-ordinary", "inbox-first", "inbox-new-mail"]);
    expect(conn.setAside, "the liar is set aside once").toBe(1);
    expect(conn.reachable, "the mailbox is served again").toBe(true);
  }, 180_000);
});
