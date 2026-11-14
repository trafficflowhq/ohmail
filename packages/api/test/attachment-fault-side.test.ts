import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { attachments as attachmentsTbl, mailboxCredentials, messages } from "@trafficflow/db";
import { ImapAdapter, ImapConnectionClosedError, MessageGoneError } from "@trafficflow/core/adapters/imap";
import {
  OAuthClientRefusedError, OAuthProviderUnavailableError, OAuthReauthRequiredError, refreshAccessToken, type FetchLike,
} from "@trafficflow/core";
import { createLogger } from "@trafficflow/core/mail";
import {
  AttachmentsService, ServiceError, ATTACHMENT_MAX_FETCH_BYTES,
} from "@trafficflow/services/mail";
import { mailServerRefusal } from "../src/mail-server-refusal.js";
import { imapDoorTimedOut } from "../src/imap-budget.js";
import { verdictFor } from "../src/imap-probe.js";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * AN ATTACHMENT FAULT NAMES ITS SIDE. The three byte routes answered any unnamed throw
 * as 502 `upstream_unavailable` — a fault of ours told as the person's mail server — with no log
 * line and no fault row, and left `retryable` off every refusal. Driven through `createApp`, so
 * the carried envelope is what answers, never the handler alone.
 */

const app = createApp(apiRoutes);
const open: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

/** A server that signs the person in and then answers the part's FETCH NO (Gmail's transient text) or BAD. */
function afterSignIn(tag: string, c: string, mode: "fetch-no" | "fetch-bad"): string {
  if (c === "SELECT" || c === "EXAMINE") return `* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n${tag} OK [READ-WRITE] done\r\n`;
  if (c === "UID" || c === "FETCH") {
    return mode === "fetch-no" ? `${tag} NO Some messages could not be FETCHed (Failure)\r\n` : `${tag} BAD Could not parse command\r\n`;
  }
  if (c === "LOGOUT") return `* BYE bye\r\n${tag} OK done\r\n`;
  return `${tag} OK done\r\n`;
}

/** A plaintext IMAP server; `login` decides how the LOGIN is answered, or what follows a good one. */
async function imapServer(login: "refuse" | "unavailable" | "limit" | "bye-unavailable" | "fetch-no" | "fetch-bad"): Promise<number> {
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
        else if (c === "LOGIN" && login === "refuse") sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (c === "LOGIN" && login === "unavailable") sock.write(`${tag} NO [UNAVAILABLE] Maximum number of connections\r\n`);
        else if (c === "LOGIN" && login === "limit") sock.write(`${tag} NO [LIMIT] Too many simultaneous connections\r\n`);
        else if (c === "LOGIN" && login === "bye-unavailable") { sock.write("* BYE [UNAVAILABLE] Too many connections\r\n"); sock.end(); }
        else if (login === "fetch-no" || login === "fetch-bad") sock.write(afterSignIn(tag!, c, login));
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  open.push(server);
  return (server.address() as net.AddressInfo).port;
}

async function world(o: {
  port?: number; secure?: boolean; sizeBytes?: number; oauthThrows?: unknown; oauthFetch?: FetchLike; noCredential?: boolean;
} = {}) {
  const made = await makeDeps(FIXED_NOW);
  // `makeDeps` stubs the IMAP dial for every other route test; this file is about the dial.
  vi.restoreAllMocks();
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const { id: messageId, mailboxId } = await seedMessage(made.db, { accountId: s.accountId, folder: "INBOX" });
  const oauth = o.oauthThrows !== undefined || o.oauthFetch !== undefined;
  const enc = await made.deps.keyProvider.encrypt("imap-pass");
  if (!o.noCredential) {
    await made.db.insert(mailboxCredentials).values({
      mailboxId, accountId: s.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: {
        host: "127.0.0.1", port: o.port ?? await closedPort(), secure: o.secure ?? false, user: "u@fault.example",
        ...(oauth ? { authType: "oauth2", provider: "microsoft" } : {}),
      },
    });
  }
  const [att] = await made.db.insert(attachmentsTbl).values({
    accountId: s.accountId, messageId, filename: "a.pdf", contentType: "application/pdf",
    sizeBytes: o.sizeBytes ?? 10, inline: false, partId: "2",
  }).returning();
  const lines: string[] = [];
  const faults: { route: string; status: number; errorClass: string }[] = [];
  const deps: ApiDeps = {
    ...made.deps, session: null, idempotency: null,
    logger: createLogger({ service: "api", level: "debug", sink: (l: string) => { lines.push(l); } }),
    faultLog: { record: async (r) => { faults.push({ route: r.route, status: r.status, errorClass: r.errorClass }); } },
    // An oauth mailbox's token source, as the Cloud host wires it: the byte door mints per call —
    // a source that throws, or the REAL refresh client over a fake token endpoint.
    ...(o.oauthThrows !== undefined
      ? { oauth: { forMailbox: () => () => async () => { throw o.oauthThrows; } } as never }
      : {}),
    ...(o.oauthFetch !== undefined
      ? { oauth: { forMailbox: () => (refreshToken: string) => async () => (await refreshAccessToken({
          tenant: "common", clientId: "client-id", clientSecret: "client-secret", refreshToken, fetch: o.oauthFetch!,
        })).accessToken } as never }
      : {}),
  };
  return { db: made.db, deps, s, messageId, attId: att!.id, lines, faults };
}

type World = Awaited<ReturnType<typeof world>>;

async function answer(res: Response): Promise<{ status: number; code?: string; retryable?: unknown }> {
  const body = await res.json() as { error?: { code?: string; retryable?: unknown } };
  return { status: res.status, code: body.error?.code, retryable: body.error?.retryable };
}

const one = (w: World): Promise<Response> =>
  app.handle(req("GET", `/attachments/${w.attId}`, { bearer: w.s.token }), w.deps);
const zipOfMessage = (w: World): Promise<Response> =>
  app.handle(req("POST", `/messages/${w.messageId}/attachments/download-all`, { bearer: w.s.token }), w.deps);
const zipOfFiles = (w: World): Promise<Response> =>
  app.handle(req("POST", "/files/download-all", { bearer: w.s.token, body: JSON.stringify({ fileIds: [w.attId] }) }), w.deps);
const ROUTES = [["GET /attachments/:id", one], ["POST …/attachments/download-all", zipOfMessage], ["POST /files/download-all", zipOfFiles]] as const;

const events = (w: World): string[] => w.lines.map((l) => (JSON.parse(l) as { event?: string }).event ?? "");

/** `_errors.txt` out of a zip route's archive; jszip is the services package's dependency. */
const JSZip = createRequire(new URL("../../services/package.json", import.meta.url))("jszip") as {
  loadAsync(b: Uint8Array): Promise<{ file(n: string): { async(t: "string"): Promise<string> } | null }>;
};
async function errorsTxt(res: Response): Promise<string> {
  const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
  return (await zip.file("_errors.txt")?.async("string")) ?? "(no _errors.txt)";
}

describe("an unnamed throw on a byte route is ours, and says so", () => {
  it.each(ROUTES)("%s: 500 internal, request_unhandled, one fault row", async (_name, call) => {
    const w = await world();
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(new TypeError("cannot read properties of undefined"));
    vi.spyOn(AttachmentsService.prototype, "downloadAll").mockRejectedValue(new TypeError("zip broke"));
    // `retryable: false` (ATTACHMENT-INTERNAL-500-OFFERS-A-RETRY-THAT-CANNOT-HELP): the tile offers no
    // Try again that would repeat our own fault, and the phone does not ask again.
    expect(await answer(await call(w))).toEqual({ status: 500, code: "internal", retryable: false });
    expect(events(w)).toContain("request_unhandled");
    expect(w.faults.map((f) => f.status)).toEqual([500]);
    expect(w.faults[0]!.errorClass).toBe("TypeError");
  });
});

describe("the person's mail server refusing is a 424 that says which refusal and whether to ask again", () => {
  it("a closed port: mail_server_unreachable, retryable", async () => {
    const w = await world();
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_unreachable", retryable: true });
    expect(w.faults, "a refusal the mail server made is no fault row of ours").toEqual([]);
  });

  it("a refused LOGIN: mail_server_login_refused, not retryable", async () => {
    const w = await world({ port: await imapServer("refuse") });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_login_refused", retryable: false });
  });

  it("TLS offered to a plaintext server: mail_server_not_secured, not retryable", async () => {
    const w = await world({ port: await imapServer("refuse"), secure: true });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_not_secured", retryable: false });
  });

  it("an oauth mailbox whose refresh token died: mailbox_reconnect_required, not retryable, no fault row", async () => {
    const w = await world({ oauthThrows: new OAuthReauthRequiredError("AADSTS70008") });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mailbox_reconnect_required", retryable: false });
    expect(w.faults).toEqual([]);
    expect(events(w)).not.toContain("request_unhandled");
  });

  it("the token endpoint down: mail_server_unreachable, retryable, no fault row", async () => {
    const w = await world({ oauthThrows: new OAuthProviderUnavailableError("token endpoint answered 503") });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_unreachable", retryable: true });
    expect(w.faults).toEqual([]);
  });

  it("the connection closing under the fetch: mail_server_unreachable, retryable", async () => {
    const w = await world();
    vi.spyOn(AttachmentsService.prototype, "fetchBytes").mockRejectedValue(new ImapConnectionClosedError());
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_unreachable", retryable: true });
  });
});

describe("every refusal of a byte route states retryable as a boolean", () => {
  const stated: [string, () => unknown, number, string, boolean][] = [
    ["mailbox_busy", () => new ServiceError("mailbox_busy", 429, "busy", { retryAfter: 2 }, true), 429, "mailbox_busy", true],
    ["mailbox_read_timeout", () => imapDoorTimedOut(20_000), 504, "mailbox_read_timeout", true],
    ["a service error that states nothing", () => new ServiceError("not_found", 404, "attachment not found"), 404, "not_found", false],
    ["CONTROL: a 5xx of ours that states nothing keeps the status reading", () => new ServiceError("upstream_failed", 503, "ours"), 503, "upstream_failed", true],
  ];
  for (const [label, make, status, code, retryable] of stated) {
    it.each(ROUTES)(`${label} — %s`, async (_name, call) => {
      const w = await world();
      vi.spyOn(AttachmentsService.prototype, "fetchBytes").mockRejectedValue(make());
      vi.spyOn(AttachmentsService.prototype, "downloadAll").mockRejectedValue(make());
      expect(await answer(await call(w))).toEqual({ status, code, retryable });
    });
  }

  it("a message deleted from the mailbox: 404 not_found, not retryable", async () => {
    const w = await world();
    await w.db.update(messages).set({ nativeLocator: null, deletedAt: FIXED_NOW }).where(eq(messages.id, w.messageId));
    expect(await answer(await one(w))).toEqual({ status: 404, code: "not_found", retryable: false });
  });

  it("a message moved since the last sync: 404 not_found, retryable — the next sync finds it again", async () => {
    const w = await world();
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* destroyed */ });
    vi.spyOn(ImapAdapter.prototype, "fetchPart").mockRejectedValue(new MessageGoneError({ folder: "INBOX", ref: "1:1" }));
    expect(await answer(await one(w))).toEqual({ status: 404, code: "not_found", retryable: true });
  });

  it("a file over the ceiling: 413 payload_too_large, not retryable", async () => {
    const w = await world({ sizeBytes: ATTACHMENT_MAX_FETCH_BYTES + 1 });
    expect(await answer(await one(w))).toEqual({ status: 413, code: "payload_too_large", retryable: false });
  });

  it("CONTROL: a byte route that answers still answers bytes", async () => {
    const w = await world();
    vi.spyOn(AttachmentsService.prototype, "fetchBytes").mockResolvedValue({
      contentType: "application/pdf", filename: "a.pdf", body: Uint8Array.from([1, 2, 3]),
    });
    const res = await one(w);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });
});

describe("mailServerRefusal — the add-time probe's classifier, as the byte door's one arm", () => {
  it.each([
    ["a refused LOGIN", Object.assign(new Error("Command failed"), { authenticationFailed: true }), "mail_server_login_refused", false],
    ["a certificate refusal", Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }), "mail_server_not_secured", false],
    ["a refused connect", Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "mail_server_unreachable", true],
    ["a server timeout", Object.assign(new Error("x"), { code: "ETIMEOUT" }), "mail_server_unreachable", true],
    // The server took the connection and would not serve it (ATTACHMENT-SERVER-AT-CAP-SAID-AS-NOT-ANSWERING):
    // busy, not silent. Consumer: the `server_busy` sentence on every reader.
    ["the server hanging up after contact", Object.assign(new Error("x"), { code: "NoConnection" }), "mail_server_busy", true],
    ["UNAVAILABLE at LOGIN", Object.assign(new Error("x"), { serverResponseCode: "UNAVAILABLE", authenticationFailed: true }), "mail_server_busy", true],
    ["LIMIT at LOGIN", Object.assign(new Error("x"), { serverResponseCode: "LIMIT" }), "mail_server_busy", true],
    ["a throttle", Object.assign(new Error("x"), { code: "ETHROTTLE" }), "mail_server_busy", true],
    ["a close after the TLS handshake", Object.assign(new Error("x"), { code: "ClosedAfterConnectTLS" }), "mail_server_busy", true],
    ["the connection closing", new ImapConnectionClosedError(), "mail_server_unreachable", true],
    // A command the server refused AFTER the sign-in: the server's side, and asking again may help.
    ["a NO after the sign-in", Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Some messages could not be FETCHed (Failure)" }), "mail_server_busy", true],
    ["a BAD after the sign-in", Object.assign(new Error("Command failed"), { responseStatus: "BAD", responseText: "Could not parse command" }), "mail_server_busy", true],
    ["CONTROL: a NO to the LOGIN itself", Object.assign(new Error("Command failed"), { responseStatus: "NO", authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }), "mail_server_login_refused", false],
  ])("%s", (_label, err, code, retryable) => {
    const r = mailServerRefusal(err);
    expect({ status: r?.httpStatus, code: r?.code, retryable: r?.retryable }).toEqual({ status: 424, code, retryable });
  });

  it("an unnamed throw and our own refusal are not the mail server's", () => {
    expect(mailServerRefusal(new TypeError("x is undefined"))).toBeNull();
    expect(mailServerRefusal(new ServiceError("mailbox_busy", 429, "busy", undefined, true))).toBeNull();
    expect(mailServerRefusal("a string")).toBeNull();
  });
});

describe("a mailbox with no sign-in here says so, and asking again cannot help", () => {
  it("GET /attachments/:id: 424 mailbox_not_signed_in, not retryable, no fault row", async () => {
    const w = await world({ noCredential: true });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mailbox_not_signed_in", retryable: false });
    expect(w.faults).toEqual([]);
    expect(events(w)).not.toContain("request_unhandled");
  });

  it.each([["POST …/attachments/download-all", zipOfMessage], ["POST /files/download-all", zipOfFiles]] as const)(
    "%s: the archive's _errors.txt says the mailbox is not signed in here", async (_name, call) => {
      const w = await world({ noCredential: true });
      const res = await call(w);
      expect(res.status).toBe(200);
      expect(await errorsTxt(res)).toMatch(/: skipped — this mailbox is not signed in here/);
      expect(w.faults).toEqual([]);
    });
});

describe("a mail server that took the connection and would not serve it is busy, not silent", () => {
  it.each(["unavailable", "limit", "bye-unavailable"] as const)("LOGIN answered %s: 424 mail_server_busy, retryable, no fault row", async (mode) => {
    const w = await world({ port: await imapServer(mode) });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_busy", retryable: true });
    expect(w.faults).toEqual([]);
  });
});

describe("a command the mail server refused after the sign-in is its side, and asking again may help", () => {
  it.each(["fetch-no", "fetch-bad"] as const)("the part's FETCH answered %s: 424 mail_server_busy, retryable, no fault row", async (mode) => {
    const w = await world({ port: await imapServer(mode) });
    expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_busy", retryable: true });
    expect(w.faults).toEqual([]);
    expect(events(w)).not.toContain("request_unhandled");
  });
});

describe("the token endpoint refusing THIS deployment's client is ours", () => {
  const endpoint = (status: number, json: unknown): FetchLike => async () => ({
    ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json),
  });

  it.each([["invalid_client", 401], ["unauthorized_client", 400], ["invalid_request", 400]] as const)(
    "%s: 500 internal, not retryable, request_unhandled, one fault row naming the class", async (error, status) => {
      const w = await world({ oauthFetch: endpoint(status, { error }) });
      expect(await answer(await one(w))).toEqual({ status: 500, code: "internal", retryable: false });
      expect(events(w)).toContain("request_unhandled");
      expect(w.faults.map((f) => [f.status, f.errorClass])).toEqual([[500, "OAuthClientRefusedError"]]);
    });

  it.each([[503, {}], [429, { error: "temporarily_unavailable" }]] as const)(
    "CONTROL: the endpoint answering %i stays the provider's, retryable, no fault row", async (status, json) => {
      const w = await world({ oauthFetch: endpoint(status, json) });
      expect(await answer(await one(w))).toEqual({ status: 424, code: "mail_server_unreachable", retryable: true });
      expect(w.faults).toEqual([]);
    });

  it("the probe's classifier cannot read it as a refused password", () => {
    expect(verdictFor(new OAuthClientRefusedError("invalid_client", 401))).toEqual({ verdict: "refuse", code: "unknown" });
  });
});

