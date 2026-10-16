/* THE MEMORY CASE'S SETUP, IN A PROCESS OF ITS OWN: put one message carrying a `mib` MiB clip into
 * the INBOX, let an engine on `dataDir` sync it, and print `{ attachmentId, bytes, sha256 }`. Its own
 * process so the APPEND and the ingest leave no freed memory in the process that is measured.
 * Usage: tsx --conditions=ohmail-source <this> <dataDir> <address> <kek hex> <mib> */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { attachments } from "@trafficflow/db";
import { createSidecar } from "../../src/engine.js";

const [dataDir, address, kekHex, mib] = process.argv.slice(2);
const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);

const bytes = randomBytes(Number(mib) * 1024 * 1024);
const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "test" }, logger: false });
await c.connect();
await c.append("INBOX", [
  `From: <${address}>`, `To: <${address}>`, "Subject: the clip", `Message-ID: <${randomUUID()}@trafficflow.test>`,
  "Date: Thu, 15 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "",
  "--b1", "Content-Type: text/plain; charset=utf-8", "", "here", "",
  "--b1", 'Content-Type: video/mp4; name="clip.mp4"', 'Content-Disposition: attachment; filename="clip.mp4"',
  "Content-Transfer-Encoding: base64", "", bytes.toString("base64").replace(/(.{76})/g, "$1\r\n"), "--b1--", "",
].join("\r\n"));
await c.logout();

const sidecar = await createSidecar({
  dataDir,
  imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "test" }, smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false } },
  address, displayName: "This computer", keks: { 1: Buffer.from(kekHex, "hex") }, pollIntervalMs: 60 * 60 * 1000,
});
const res = await sidecar.handle(new Request(`http://sidecar/mailboxes/${sidecar.world.mailboxId}`, {
  method: "PATCH",
  headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
  body: JSON.stringify({ imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: "test" } }),
}));
if (res.status !== 200) throw new Error(`the mailbox could not be set: ${res.status}`);
await sidecar.start();
let row;
for (let i = 0; i < 240 && !row; i += 1) {
  const rows = await sidecar.db.select().from(attachments).where(eq(attachments.accountId, sidecar.world.accountId));
  row = rows.find((r) => r.filename === "clip.mp4");
  if (!row) await new Promise((r) => setTimeout(r, 250));
}
await sidecar.stop();
if (!row) throw new Error("the clip never synced");
process.stdout.write(`${JSON.stringify({ attachmentId: row.id, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") })}\n`);
process.exit(0);
