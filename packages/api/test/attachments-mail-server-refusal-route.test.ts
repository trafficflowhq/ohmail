import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { attachments as attachmentsTbl, mailboxCredentials, messages } from "@trafficflow/db";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * THE ONE-ATTACHMENT ROUTE, WHEN THE PERSON'S MAIL SERVER REFUSES OR CANNOT BE REACHED. It
 * answered every non-`ServiceError` as 502 `upstream_unavailable`, a 5xx the platform counts as
 * ours. A refusal the mail server made is now 424 with a code naming the refusal and a retry flag
 * saying whether asking again can help; an unclassified throw is the envelope's 500. A message
 * tombstoned out of the mailbox has no location, and says so as the 404 the gone arm answers.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const open: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** An IMAP server that refuses the LOGIN the way a wrong password is refused. */
async function imapRefusingLogin(): Promise<number> {
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const [tag, cmd] = buf.slice(0, i).split(" ");
        buf = buf.slice(i + 2);
        const c = (cmd ?? "").toUpperCase();
        if (c === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (c === "LOGIN") sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  open.push(server);
  return (server.address() as net.AddressInfo).port;
}

async function world(imapPort: number) {
  const made = await makeDeps(FIXED_NOW);
  // `makeDeps` stubs the IMAP dial for every other route test; this file is about the dial.
  vi.restoreAllMocks();
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const { id: messageId, mailboxId } = await seedMessage(made.db, { accountId: s.accountId, folder: "INBOX" });
  const enc = await made.deps.keyProvider.encrypt("imap-pass");
  await made.db.insert(mailboxCredentials).values({
    mailboxId, accountId: s.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "127.0.0.1", port: imapPort, secure: false, user: "u@refusal.example" },
  });
  const [att] = await made.db.insert(attachmentsTbl).values({
    accountId: s.accountId, messageId, filename: "a.pdf", contentType: "application/pdf",
    sizeBytes: 10, inline: false, partId: "2",
  }).returning();
  return { ...made, s, messageId, attId: att!.id };
}

type World = Awaited<ReturnType<typeof world>>;

async function answer(res: Response): Promise<{ status: number; code?: string; retryable?: boolean }> {
  const body = await res.json() as { error?: { code?: string; retryable?: boolean } };
  return { status: res.status, code: body.error?.code, retryable: body.error?.retryable };
}

const one = (w: World): Promise<Response> => H(req("GET", `/attachments/${w.attId}`, { bearer: w.s.token }), w.deps);
const zipOfMessage = (w: World): Promise<Response> =>
  H(req("POST", `/messages/${w.messageId}/attachments/download-all`, { bearer: w.s.token }), w.deps);
const zipOfFiles = (w: World): Promise<Response> =>
  H(req("POST", "/files/download-all", { bearer: w.s.token, body: JSON.stringify({ fileIds: [w.attId] }) }), w.deps);


describe("attachment bytes when the mail server refuses or cannot be reached", () => {
  it("GET /attachments/:id — a refused dial is 424 mail_server_unreachable, still retryable", async () => {
    expect(await answer(await one(await world(await closedPort()))))
      .toEqual({ status: 424, code: "mail_server_unreachable", retryable: true });
  });

  it("GET /attachments/:id — a refused LOGIN is 424 mail_server_login_refused, not retryable", async () => {
    expect(await answer(await one(await world(await imapRefusingLogin()))))
      .toEqual({ status: 424, code: "mail_server_login_refused", retryable: false });
  });

  it("CONTROL: both download-all routes keep a refused dial INSIDE the archive and answer 200", async () => {
    // Measured: the per-mailbox catch turns a failed open into an `_errors.txt` line, so the
    // route's own catch is reached only by a fault of ours.
    expect((await zipOfMessage(await world(await closedPort()))).status).toBe(200);
    expect((await zipOfFiles(await world(await closedPort()))).status).toBe(200);
  });

  it("a message tombstoned out of the mailbox is the 404 the gone arm answers, not a 502", async () => {
    const w = await world(await closedPort());
    await w.db.update(messages).set({ nativeLocator: null, deletedAt: FIXED_NOW }).where(eq(messages.id, w.messageId));
    const a = await answer(await one(w));
    expect({ status: a.status, code: a.code }).toEqual({ status: 404, code: "not_found" });
  });

  it("CONTROL: an unclassified throw in the open path is ours, the envelope's 500", async () => {
    const w = await world(await closedPort());
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(new TypeError("cannot read properties of undefined"));
    // Not retryable: the tile's Try again would only repeat our own fault.
    expect(await answer(await one(w))).toEqual({ status: 500, code: "internal", retryable: false });
  });
});

/** `_errors.txt` out of an archive; jszip is the services package's dependency. */
const JSZip = createRequire(new URL("../../services/package.json", import.meta.url))("jszip") as {
  loadAsync(b: Uint8Array): Promise<{ file(n: string): { async(t: "string"): Promise<string> } | null }>;
};
async function errorsTxt(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
  return (await zip.file("_errors.txt")?.async("string")) ?? "(no _errors.txt)";
}

describe("ZIP-ROUTES-SAY-A-REFUSED-OPEN-AS-UNAVAILABLE — a zip's _errors.txt says what happened", () => {
  const ZIPS = [["POST …/attachments/download-all", zipOfMessage], ["POST /files/download-all", zipOfFiles]] as const;

  it.each(ZIPS)("%s: a refused LOGIN is named as the refused sign-in", async (_n, call) => {
    const text = await errorsTxt(await call(await world(await imapRefusingLogin())));
    expect(text).toMatch(/a\.pdf: skipped — your mail server refused the sign-in/);
    expect(text).not.toMatch(/unavailable/);
  });

  it.each(ZIPS)("%s: the closed port is the server that could not be reached", async (_n, call) => {
    const text = await errorsTxt(await call(await world(await closedPort())));
    expect(text).toMatch(/a\.pdf: skipped — your mail server could not be reached/);
  });

  it.each(ZIPS)("%s: a throw of ours at the open is ohmail's, never the mail server's", async (_n, call) => {
    const w = await world(await closedPort());
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(new TypeError("cannot read properties of undefined"));
    const text = await errorsTxt(await call(w));
    expect(text).toMatch(/a\.pdf: skipped — ohmail could not open this mailbox/);
    expect(text).not.toMatch(/mail server/);
  });

  it.each(ZIPS)("%s: a connection reset reading a part is the mail server that could not be reached", async (_n, call) => {
    const w = await world(await closedPort());
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* destroyed */ });
    vi.spyOn(ImapAdapter.prototype, "fetchPart").mockRejectedValue(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    const text = await errorsTxt(await call(w));
    expect(text).toMatch(/a\.pdf: skipped — your mail server could not be reached/);
  });

  it.each(ZIPS)("%s: a throw of ours reading a part is ohmail's too", async (_n, call) => {
    const w = await world(await closedPort());
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* destroyed */ });
    vi.spyOn(ImapAdapter.prototype, "fetchPart").mockRejectedValue(new TypeError("cannot read properties of undefined"));
    const text = await errorsTxt(await call(w));
    expect(text).toMatch(/a\.pdf: skipped — ohmail could not fetch this part/);
    expect(text).not.toMatch(/mail server/);
  });
});
