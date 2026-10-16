import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { attachments } from "@trafficflow/db";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { ATTACHMENT_FILE_TARGET_HEADER } from "../src/attachment-file.js";

/**
 * A FILE OHMAIL SENDS OPENS WHEN IT COMES BACK — the 33 and 40 MiB cases over a real GreenMail.
 * The desktop sends up to 40 MiB, and a single download was refused past 32 MiB. Both reads are
 * driven: the buffered `GET /attachments/:id` the preview uses, and the save the shell asks for
 * (`POST /attachments/:id/file`), which streams the part into the file the shell named. Each is
 * compared to the original by sha256. What the save costs in memory is
 * `attachment-open-ceiling-memory.e2e.test.ts`'s.
 *
 * Mutations watched: `ATTACHMENT_MAX_FETCH_BYTES` back to 32 MiB → both cases go red (413); the
 * opener reading the header as a raw path → both go red (the staging folder is Cyrillic); the
 * opener's staging-folder rule (by name or by real path) removed → the refusal case goes red.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
const MIB = 1024 * 1024;

interface Launch { sidecar: Sidecar; host: StdioHost; client: StdioClient; dataDir: string; staging: string }
const launches: Launch[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const l of launches.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function launch(address: string): Promise<Launch> {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-open-"));
  dirs.push(dataDir);
  // A profile folder named in Cyrillic, as on a Windows account: the target crosses a header.
  const staging = join(dataDir, "профиль Дмитрий", "opened");
  mkdirSync(staging, { recursive: true });
  const sidecar = await createSidecar({
    dataDir,
    attachmentStagingDir: staging,
    imap: {
      host: IMAP_HOST, port: IMAP_PORT, secure: false,
      auth: { user: address, pass: "test" },
      smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false },
    },
    address,
    displayName: "This computer",
    keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
    pollIntervalMs: 60 * 60 * 1000,
  });
  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    credentialState: await sidecar.credentialState(),
  });
  const l = { sidecar, host, client, dataDir, staging };
  launches.push(l);
  const res = await client.fetch(`/mailboxes/${sidecar.world.mailboxId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: "test" } }),
  });
  expect(res.status).toBe(200);
  return l;
}

/** A video-shaped payload: not compressible to nothing, not all one byte. */
function clip(bytes: number): Buffer {
  const b = randomBytes(bytes);
  for (let i = 0; i < bytes; i += 4096) b[i] = i & 0xff;
  return b;
}

/** Put one message carrying `bytes` as `clip.mp4` straight into the INBOX of `address`. */
async function appendClip(address: string, bytes: Buffer): Promise<void> {
  const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "test" }, logger: false });
  await c.connect();
  try {
    const b64 = bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
    const raw = [
      `From: <${address}>`, `To: <${address}>`, "Subject: the clip", `Message-ID: <${randomUUID()}@trafficflow.test>`,
      "Date: Thu, 15 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "",
      "--b1", "Content-Type: text/plain; charset=utf-8", "", "here", "",
      "--b1", 'Content-Type: video/mp4; name="clip.mp4"', 'Content-Disposition: attachment; filename="clip.mp4"',
      "Content-Transfer-Encoding: base64", "", b64, "--b1--", "",
    ].join("\r\n");
    await c.append("INBOX", raw);
  } finally {
    await c.logout().catch(() => undefined);
  }
}

/** Start the engine and wait for the clip's attachment row. */
async function clipRow(l: Launch): Promise<{ id: string; sizeBytes: number }> {
  await l.sidecar.start();
  for (let i = 0; i < 240; i += 1) {
    const rows = await l.sidecar.db.select().from(attachments).where(eq(attachments.accountId, l.sidecar.world.accountId));
    const row = rows.find((r) => r.filename === "clip.mp4");
    if (row) return { id: row.id, sizeBytes: row.sizeBytes };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the clip never synced");
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const auth = (l: Launch): Record<string, string> => ({ authorization: `Bearer ${l.sidecar.sessionToken}` });

/** A staging path of the shape the shell mints, in the staging folder the engine was given. */
function stagingPath(l: Launch): string {
  return join(l.staging, `${randomBytes(16).toString("hex")}.part`);
}

/** The target header as the shell sends it: base64 of the path's UTF-8. */
const targetHeader = (path: string): Record<string, string> =>
  ({ [ATTACHMENT_FILE_TARGET_HEADER]: Buffer.from(path, "utf8").toString("base64") });

describe("an attachment as large as the app sends opens and saves byte for byte", () => {
  it.each([33, 40])("%i MiB: the buffered read and the streamed save both equal the original", async (mib) => {
    const address = `open-${randomUUID()}@trafficflow.test`;
    const bytes = clip(mib * MIB);
    await appendClip(address, bytes);
    const l = await launch(address);
    const row = await clipRow(l);
    expect(row.sizeBytes).toBe(bytes.byteLength);

    const got = await l.client.fetch(`/attachments/${row.id}`, { headers: auth(l) });
    expect(got.status, await got.clone().text().then((t) => t.slice(0, 200))).toBe(200);
    const body = new Uint8Array(await got.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
    expect(sha(body)).toBe(sha(bytes));

    const target = stagingPath(l);
    const saved = await l.client.fetch(`/attachments/${row.id}/file`, {
      method: "POST", headers: { ...auth(l), ...targetHeader(target) },
    });
    const answer = await saved.json() as { bytes: number; sha256: string };
    expect(saved.status, JSON.stringify(answer)).toBe(200);
    expect(answer).toMatchObject({ bytes: bytes.byteLength, sha256: sha(bytes) });
    expect(sha(readFileSync(target))).toBe(sha(bytes));
  }, 300_000);

  it("the save writes only a new file directly in the staging folder, compared by real path", async () => {
    const address = `open-${randomUUID()}@trafficflow.test`;
    await appendClip(address, clip(64 * 1024));
    const l = await launch(address);
    const row = await clipRow(l);
    const existing = stagingPath(l);
    writeFileSync(existing, "the reader's own file");
    const name = (): string => `${randomBytes(16).toString("hex")}.part`;
    // Folders that EXIST and are named `opened`, so the staging-folder rule is what refuses them.
    const elsewhere = join(l.dataDir, "elsewhere", "opened");
    mkdirSync(elsewhere, { recursive: true });
    const linked = join(l.dataDir, "linked", "opened");
    mkdirSync(join(l.dataDir, "linked"));
    symlinkSync(elsewhere, linked);
    const outside = join(elsewhere, name());
    const viaLink = join(linked, name());
    const dotted = `${l.staging}/../../elsewhere/opened/${name()}`;
    // These two resolve INTO the staging folder, so only the by-name rules refuse them.
    const up = `${l.staging}/../opened/${name()}`;
    const doubled = `/${l.staging}/${name()}`;
    const targets = [null, "relative/opened/x.part", join(l.staging, "notes.txt"), outside, viaLink, dotted, up, doubled, existing];
    for (const target of targets) {
      const res = await l.client.fetch(`/attachments/${row.id}/file`, {
        method: "POST", headers: { ...auth(l), ...(target ? targetHeader(target) : {}) },
      });
      expect(res.status, String(target)).toBe(400);
    }
    // The raw path in the header, the shape before base64, is refused too.
    const raw = await l.client.fetch(`/attachments/${row.id}/file`, {
      method: "POST", headers: { ...auth(l), [ATTACHMENT_FILE_TARGET_HEADER]: join(l.staging, name()).replace(/[^\x20-\x7e]/g, "_") },
    });
    expect(raw.status).toBe(400);
    expect(readFileSync(existing, "utf8")).toBe("the reader's own file");
    expect([existsSync(outside), existsSync(viaLink)]).toEqual([false, false]);
  }, 120_000);
});
