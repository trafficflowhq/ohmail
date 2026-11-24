import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { attachments as attachmentsTbl, mailboxCredentials } from "@trafficflow/db";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { greenmailEndpoint, readLaneGreenmail } from "../../../scripts/lib/lane-greenmail-env.mjs";
import { closeKeptImap, KEPT_IMAP_PROVE_AFTER_MS } from "../src/attachments-adapter.js";
import { makeDeps, seedSession, seedMessage, req } from "./helpers.js";

/**
 * THE PICTURES OF ONE LETTER COST ONE SIGN-IN, NOT ONE EACH. A letter with eight embedded pictures
 * asks `GET /attachments/:id` eight times, two at a time. Each request used to dial, sign in and
 * list the folders afresh, so the eighth picture waited behind four sign-ins in a row. Against a
 * real GreenMail, through the route a client calls, this counts the sign-ins the requests make and
 * the sessions the server end sees: GreenMail publishes no count of its own over its mail ports, so
 * the dial goes through a relay in front of it that counts each session and how many stay open.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gm = greenmailEndpoint(process.env, readLaneGreenmail(REPO_ROOT));
const PICTURES = 8;

const { ImapFlow } = createRequire(new URL("../../core/package.json", import.meta.url))("imapflow") as {
  ImapFlow: new (o: Record<string, unknown>) => {
    connect(): Promise<void>; logout(): Promise<void>; close(): void;
    append(path: string, raw: string, flags: string[]): Promise<{ uid?: number; uidValidity?: bigint }>;
    mailboxOpen(path: string): Promise<{ uidValidity: bigint }>;
  };
};

const picture = (i: number): Buffer => Buffer.alloc(20_000 + i, i + 1);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function letter(): string {
  const b = `b-${randomUUID()}`;
  const lines = [
    `Message-ID: <${randomUUID()}@pictures.test>`, "From: tom@example.net", "To: sam@example.com",
    "Subject: The kitchen in pictures", "MIME-Version: 1.0", `Content-Type: multipart/related; boundary="${b}"`, "",
    `--${b}`, "Content-Type: text/html; charset=utf-8", "",
    `<p>${Array.from({ length: PICTURES }, (_, i) => `<img src="cid:p${i}@pictures.test">`).join("")}</p>`,
  ];
  for (let i = 0; i < PICTURES; i++) {
    lines.push(`--${b}`, "Content-Type: image/png", "Content-Transfer-Encoding: base64",
      `Content-ID: <p${i}@pictures.test>`, `Content-Disposition: inline; filename="p${i}.png"`, "",
      picture(i).toString("base64").replace(/.{76}/g, "$&\r\n"));
  }
  lines.push(`--${b}--`, "");
  return lines.join("\r\n");
}

/** The letter in the user's INBOX; its locator. */
async function plant(user: string): Promise<{ folder: string; ref: string }> {
  const c = new ImapFlow({ host: gm.imapHost, port: gm.imapPort, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  try {
    const appended = await c.append("INBOX", letter(), []);
    const box = await c.mailboxOpen("INBOX");
    return { folder: "INBOX", ref: `${appended.uidValidity ?? box.uidValidity}:${appended.uid ?? 1}` };
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** A relay in front of GreenMail that counts sessions, and can go silent the way a dropped line does. */
async function relay(): Promise<{ port: number; sessions: () => number; open: () => number; silence: () => void; close: () => void }> {
  const live = new Set<net.Socket>();
  const pairs: { silent: boolean }[] = [];
  let sessions = 0;
  const srv = net.createServer((c) => {
    sessions += 1;
    live.add(c);
    const s = net.connect(gm.imapPort, gm.imapHost);
    const pair = { silent: false };
    pairs.push(pair);
    c.on("data", (d) => { if (!pair.silent) s.write(d); });
    s.on("data", (d) => { if (!pair.silent) c.write(d); });
    const end = (): void => { live.delete(c); c.destroy(); s.destroy(); };
    for (const sock of [c, s]) { sock.on("close", end); sock.on("error", end); }
  });
  const port = await new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)));
  return {
    port,
    sessions: () => sessions,
    open: () => live.size,
    // Every session open now stops passing bytes both ways and never closes; later ones pass.
    silence: () => { for (const p of pairs) p.silent = true; },
    close: () => { for (const c of live) c.destroy(); srv.close(); },
  };
}

/** Wait until `ok()` holds, at most `ms`. */
async function until(ok: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

/** A planted letter of eight pictures, its mailbox signed in through a fresh relay; the picture ids. */
async function setUp(keepImap: boolean) {
  const user = `pic-${randomUUID()}@trafficflow.test`;
  const locator = await plant(user);
  const gate = await relay();
  relays.push(gate);
  const made = await makeDeps(new Date());
  // `makeDeps` stubs the dial for tests that need none; this one dials the real server.
  vi.restoreAllMocks();
  // The host's word: a process that lives on keeps; one that freezes after its answer does not.
  const deps = (keepImap ? { ...made.deps, services: { ...made.deps.services, keepImap: true } } : made.deps) as ApiDeps;
  const s = await seedSession(made.db, { now: new Date() });
  const { id: messageId, mailboxId } = await seedMessage(made.db, { accountId: s.accountId, folder: "INBOX", nativeLocator: locator });
  const enc = await made.deps.keyProvider.encrypt("test");
  await made.db.insert(mailboxCredentials).values({
    mailboxId, accountId: s.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "127.0.0.1", port: gate.port, secure: false, user },
  });
  const ids: string[] = [];
  for (let i = 0; i < PICTURES; i++) {
    const [row] = await made.db.insert(attachmentsTbl).values({
      accountId: s.accountId, messageId, filename: `p${i}.png`, contentType: "image/png",
      sizeBytes: picture(i).byteLength, inline: true, contentId: `p${i}@pictures.test`,
      partId: String(i + 2), contentSha256: sha(picture(i)),
    }).returning();
    ids.push(row!.id);
  }
  const get = async (i: number): Promise<void> => {
    const res = await H(req("GET", `/attachments/${ids[i]}`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(picture(i))).toBe(true);
  };
  return { gate, get };
}

const relays: { close: () => void }[] = [];
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

afterEach(() => {
  closeKeptImap();
  for (const r of relays.splice(0)) r.close();
  vi.restoreAllMocks();
});

describe("the pictures of one letter, against GreenMail", { timeout: 30_000 }, () => {
  it("eight pictures asked two at a time sign in at most twice, and every picture is its own bytes", async () => {
    const { gate, get } = await setUp(true);
    const signIns = vi.spyOn(ImapAdapter.prototype, "connect");
    for (let i = 0; i < PICTURES; i += 2) await Promise.all([get(i), get(i + 1)]);
    // Before: one sign-in per picture, eight.
    expect(signIns.mock.calls.length).toBeLessThanOrEqual(2);
    expect(gate.sessions()).toBeLessThanOrEqual(2);
    // The host going down leaves nothing signed in at the server.
    closeKeptImap();
    await until(() => gate.open() === 0);
    expect(gate.open()).toBe(0);
  });

  it("a host that freezes after its answer keeps nothing: every picture signs in and logs out", async () => {
    const { gate, get } = await setUp(false);
    for (let i = 0; i < PICTURES; i += 2) await Promise.all([get(i), get(i + 1)]);
    expect(gate.sessions()).toBe(PICTURES);
    await until(() => gate.open() === 0);
    expect(gate.open()).toBe(0);
  });

  it("a kept connection the server stopped answering is not used: the next picture comes over a fresh sign-in", async () => {
    const { gate, get } = await setUp(true);
    await get(0);
    expect(gate.sessions()).toBe(1);
    // The line drops without a goodbye: the socket stays up, the server never answers on it again.
    gate.silence();
    await new Promise((r) => setTimeout(r, KEPT_IMAP_PROVE_AFTER_MS + 100));
    await get(1);
    expect(gate.sessions()).toBe(2);
    await until(() => gate.open() === 1);
    expect(gate.open()).toBe(1);
  });
});
