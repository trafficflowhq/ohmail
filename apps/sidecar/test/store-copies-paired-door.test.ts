import fs, { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { messages } from "@trafficflow/db/mail";
import type { MessageDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { createCloudSidecar, MIRROR_OWNER_FILE, readMirrorRevoked, type CloudSidecar } from "../src/cloud-engine.js";
import { encodeMirrorRecord, normalizeBase } from "../src/cloud-origin.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A PAIRED DESKTOP'S EARLIER COPIES, AND THE EVENTS THAT TAKE THEM. Beside its mirror a paired
 * desktop may hold the mirror it had under 1.0, moved aside whole, and folders an earlier store was
 * set aside into: all of it the account's mail. A session revoked at the server, the account's
 * erasure and a mailbox erased on the account each remove every such folder, as they remove the
 * mirror's own copy. The person's own sign-out and a session that merely lapsed remove none, as
 * they keep the mirror. The engine never reads one, and nothing it says names one.
 */

const COPIES = ["set-aside-refill-20261117T101323Z", "set-aside-20260926T101323Z"];
const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MSG_ONE = "11111111-1111-4111-8111-111111111111";
const iso = (): string => new Date().toISOString();
const send = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

function messageDTO(id: string): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `<${id}@sender.test>`, subject: "a letter",
    from: { name: null, address: "friend@elsewhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX",
    snippet: "hello", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
const page = (deletes: SyncChange[], cursor: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes }, cursor, hasMore: false, serverTime: iso(),
});

/** A hosted account: one mailbox, one letter, and the four things its server can do to this desktop. */
function hostedApi() {
  const state = { erased: false, refresh: null as string | null, mailboxErased: false };
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (state.erased) {
      return send({ error: { code: "account_erased", message: "this account has been deleted" } }, 410, { "X-Ohmail-Account": CLOUD_ACCOUNT });
    }
    if (state.refresh !== null) {
      return url.pathname === "/auth/refresh"
        ? send({ error: { code: state.refresh, message: "invalid refresh token" } }, 401)
        : send({ error: { code: "unauthorized", message: "no session" } }, 401);
    }
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync/snapshot") {
      return send({
        asOfSeq: 1, nextCursor: null, window: { days: 90, minRows: 5000 },
        changes: [{ type: "message", op: "create", id: MSG_ONE, seq: 1, updatedAt: iso(), entity: messageDTO(MSG_ONE) }],
      });
    }
    if (url.pathname === "/sync") {
      return state.mailboxErased && url.searchParams.get("types") !== "rule"
        ? send(page([{ type: "mailbox", op: "delete", id: CLOUD_MAILBOX, seq: 9, updatedAt: iso() }], "c9"))
        : send(page([], "c1"));
    }
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/auth/refresh") return send({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } });
    if (url.pathname === "/auth/logout") return send({});
    if (url.pathname === "/consent") return send({ settings: {} });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

interface Rig {
  sidecar: CloudSidecar;
  dataDir: string;
  api: ReturnType<typeof hostedApi>;
  auth: Record<string, string>;
  lines: string[];
  health: () => Promise<Record<string, unknown>>;
  letters: () => Promise<number>;
}

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
let realRename: typeof fs.renameSync | null = null;
afterEach(async () => {
  if (realRename !== null) { fs.renameSync = realRename; realRename = null; }
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The rename that commits a copy's removal fails, as a folder held open elsewhere fails it. */
function failRemovals(): () => void {
  const real = fs.renameSync;
  realRename = real;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (COPIES.some((n) => String(from).endsWith(n))) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return real(from, to);
  }) as typeof fs.renameSync;
  return () => { fs.renameSync = real; realRename = null; };
}

/** A paired desktop that has mirrored its account's one letter, with the earlier copies beside the mirror. */
async function rig(): Promise<Rig> {
  const dataDir = await freshDataDir("ohmail-copies-paired-");
  dirs.push(dataDir);
  // This account's own directory on this server: a launch for it discards nothing.
  writeFileSync(join(dataDir, MIRROR_OWNER_FILE), encodeMirrorRecord("me@ohmail.test", normalizeBase("https://cloud.test")));
  for (const name of COPIES) {
    mkdirSync(join(dataDir, name, "pgdata"), { recursive: true });
    // Never read: bytes no store could be, behind modes nothing may open.
    writeFileSync(join(dataDir, name, "pgdata", "PG_VERSION"), randomBytes(64), { mode: 0o000 });
    writeFileSync(join(dataDir, name, "cloud-cursor.json"), randomBytes(64), { mode: 0o000 });
  }
  const api = hostedApi();
  const lines: string[] = [];
  const logger = createSidecarLogger({ sink: (line) => { lines.push(line); } });
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" },
    keks: { 1: randomBytes(32) }, fetchImpl: api.fetchImpl, pollIntervalMs: 40, log: diagnosticFor(logger),
  });
  sidecars.push(sidecar);
  await sidecar.start();
  const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
  const r: Rig = {
    sidecar, dataDir, api, auth, lines,
    health: async () => (await sidecar.handle(new Request("http://sidecar/health"))).json() as Promise<Record<string, unknown>>,
    letters: async () => Number((await sidecar.db.select({ n: sql<number>`count(*)::int` }).from(messages))[0]!.n),
  };
  await until("the first letter mirrored", async () => (await r.letters()) === 1);
  return r;
}

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const standing = (dataDir: string): string[] => COPIES.filter((n) => existsSync(join(dataDir, n)));
/** The server's verdict reaches this desktop on its next request; the sign-in door answers only after the whole teardown. */
async function afterTheTeardown(r: Rig, flag: "sessionExpired" | "accountErased"): Promise<void> {
  await r.sidecar.handle(new Request("http://sidecar/consent", { headers: r.auth }));
  await until(`/health.${flag}`, async () => (await r.health())[flag] === true);
  await r.sidecar.handle(new Request("http://sidecar/cloud/signin", { method: "POST", headers: r.auth, body: "{" }));
}

describe("a paired desktop's earlier copies", () => {
  it("stay through an ordinary session, are never read, and nothing the engine says names one", async () => {
    const r = await rig();
    expect(standing(r.dataDir)).toEqual(COPIES);
    const said = `${JSON.stringify(await r.health())}\n${r.lines.join("\n")}`;
    for (const word of ["set-aside", "store-before", "proven", "store-copies", r.dataDir, "@"]) {
      expect(said, `the engine named ${word}`).not.toContain(word);
    }
  }, 60_000);

  it("go when the session is revoked at its server, at the event", async () => {
    const r = await rig();
    r.api.state.refresh = "refresh_revoked";
    await afterTheTeardown(r, "sessionExpired");
    expect(standing(r.dataDir)).toEqual([]);
    expect(await r.letters(), "the mirror's own copy of the mail stayed").toBe(0);
  }, 60_000);

  it("a revoked session's copy that cannot be removed keeps the removal owed past the stop, and the next launch finishes it", async () => {
    const r = await rig();
    const restore = failRemovals();
    r.api.state.refresh = "refresh_revoked";
    await afterTheTeardown(r, "sessionExpired");
    expect(standing(r.dataDir)).toEqual(COPIES);
    await r.sidecar.stop();
    sidecars.splice(sidecars.indexOf(r.sidecar), 1);
    expect(standing(r.dataDir)).toEqual(COPIES);
    expect(readMirrorRevoked(r.dataDir), "the flag was dropped over a copy still on the disk").toBe(true);
    restore();
    const again = await createCloudSidecar({
      dataDir: r.dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test", keks: { 1: randomBytes(32) }, fetchImpl: r.api.fetchImpl,
    });
    sidecars.push(again);
    expect(standing(r.dataDir)).toEqual([]);
    expect(readMirrorRevoked(r.dataDir)).toBe(false);
  }, 60_000);

  it("go when the account is erased, at the event", async () => {
    const r = await rig();
    r.api.state.erased = true;
    await afterTheTeardown(r, "accountErased");
    expect(standing(r.dataDir)).toEqual([]);
  }, 60_000);

  it("go before a mailbox's erasure is applied; while one cannot go, the receipt is not applied and is asked for again", async () => {
    const r = await rig();
    const restore = failRemovals();
    r.api.state.mailboxErased = true;
    await until("the pull met the receipt and was refused", () => r.lines.some((l) => l.includes("store_copies_removal_failed")));
    await new Promise((res) => setTimeout(res, 200));
    expect(await r.letters(), "the erasure was applied over a copy that still holds the mailbox's mail").toBe(1);
    expect(standing(r.dataDir)).toEqual(COPIES);
    restore();
    await until("the receipt applied", async () => (await r.letters()) === 0, 60_000);
    expect(standing(r.dataDir)).toEqual([]);
  }, 120_000);

  it("stay through the person's own sign-out, as the mirror does", async () => {
    const r = await rig();
    const res = await r.sidecar.handle(new Request("http://sidecar/cloud/session", { method: "DELETE", headers: r.auth }));
    expect(res.status).toBe(200);
    expect(standing(r.dataDir)).toEqual(COPIES);
    expect(await r.letters()).toBe(1);
  }, 60_000);

  it("stay through a session that lapsed and was not revoked, as the mirror does", async () => {
    const r = await rig();
    r.api.state.refresh = "refresh_expired";
    await afterTheTeardown(r, "sessionExpired");
    expect(standing(r.dataDir)).toEqual(COPIES);
    expect(await r.letters()).toBe(1);
    await r.sidecar.stop();
    sidecars.splice(sidecars.indexOf(r.sidecar), 1);
    expect(standing(r.dataDir)).toEqual(COPIES);
  }, 60_000);
});
