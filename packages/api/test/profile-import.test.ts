import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "../src/routes/local.js";
import { selfHostRoutes } from "../src/routes/self-host.js";
import type { ProfileImportService } from "@trafficflow/services/mail";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * THE CONFIRM-IMPORT ROUTES — the HTTP layer over `ProfileImportService`. What only this level
 * proves: (1) the four routes ride the mailbox group into EVERY product composition (hosted,
 * local engine, self-host), so a table that dropped the mount is red here; (2) the pipeline
 * defends them — no session is 401, and an UNVERIFIED address may ask the card's question (a read
 * that never dials) but not press Import, which dials and rewrites rules; (3) the wiring is
 * faithful; (4) the card's question never dials, whatever the mailbox would answer.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const patternsOf = (routes: { method: string; pattern: string }[]): string[] =>
  routes.map((r) => `${r.method} ${r.pattern}`);

describe("the mount — every composition with product UI carries the flow", () => {
  const FOUR = [
    "GET /mailboxes/:id/profile-import",
    "POST /mailboxes/:id/profile-import",
    "POST /mailboxes/:id/profile-import/decline",
    "POST /mailboxes/:id/profile-import/replace",
  ];
  it("hosted, local engine and self-host each serve all four routes", () => {
    for (const table of [apiRoutes, localRoutes, selfHostRoutes]) {
      const patterns = patternsOf(table);
      for (const p of FOUR) expect(patterns, `missing ${p}`).toContain(p);
    }
  });
});

describe("the pipeline in front of the handlers", () => {
  it("no session is 401 on all four", async () => {
    const { deps } = await makeDeps();
    for (const [method, path] of [
      ["GET", "/mailboxes/00000000-0000-0000-0000-000000000000/profile-import"],
      ["POST", "/mailboxes/00000000-0000-0000-0000-000000000000/profile-import"],
      ["POST", "/mailboxes/00000000-0000-0000-0000-000000000000/profile-import/decline"],
      ["POST", "/mailboxes/00000000-0000-0000-0000-000000000000/profile-import/replace"],
    ] as const) {
      const res = await H(req(method, path, method === "GET" ? {} : { body: "{}" }), deps);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("an UNVERIFIED address is refused the press — a dial and a rules rewrite are not for unproven accounts", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, emailVerified: false });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import`, {
      bearer: s.token, body: JSON.stringify({ fingerprint: "f".repeat(64) }),
    }), deps);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("email_unverified");
    // The card's question is a read: the organizer's record, no dial and no work.
    const asked = await H(req("GET", `/mailboxes/${mailboxId}/profile-import`, { bearer: s.token }), deps);
    expect(asked.status).toBe(200);
  });
});

describe("the wiring, over a spy service", () => {
  /** A bag whose profileImport is the spy — the accessor prefers the bag over the singleton. */
  function withSpy(deps: ApiDeps, spy: Partial<ProfileImportService>): ApiDeps {
    return { ...deps, services: { ...deps.services!, profileImport: spy as ProfileImportService } };
  }

  it("GET hands the mailbox id through and returns the service's candidate verbatim", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const seen: unknown[] = [];
    const candidate = {
      state: "found", fingerprint: "f".repeat(64), updatedAt: "2026-08-10T09:00:00.000Z",
      producer: { kind: "local", version: "0.9.3" },
      counts: { screener: 142, rules: 8, notifyRules: 1, tags: 3, awayResponder: false },
    };
    const spy: Partial<ProfileImportService> = {
      candidate: async (...args: unknown[]) => {
        seen.push(args[1], args.length);
        return candidate as never;
      },
    };
    const res = await H(req("GET", `/mailboxes/${mailboxId}/profile-import`, { bearer: s.token }), withSpy(deps, spy));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(candidate);
    // The id travels and nothing else: no reader seam, so the card's question cannot dial.
    expect(seen).toEqual([mailboxId, 2]);
  });

  it("POST passes the confirmed fingerprint and answers the applied counts", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const seen: unknown[] = [];
    const applied = {
      imported: { screener: 2, rules: 3, notifyRules: 1, tags: 2, awayResponder: true },
      skippedRules: 0, seq: 7,
    };
    const spy: Partial<ProfileImportService> = {
      apply: async (_ctx, id, body) => {
        seen.push(id, body.fingerprint);
        return applied as never;
      },
    };
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import`, {
      bearer: s.token, body: JSON.stringify({ fingerprint: "abc123" }),
    }), withSpy(deps, spy));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(applied);
    expect(seen).toEqual([mailboxId, "abc123"]);
  });

  it("the decline carries its subject (fingerprint or newer version) and answers dismissed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const seen: unknown[] = [];
    const spy: Partial<ProfileImportService> = {
      decline: async (_ctx, id, body) => { seen.push(id, body.fingerprint ?? body.v); },
    };
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import/decline`, {
      bearer: s.token, body: JSON.stringify({ fingerprint: "abc123" }),
    }), withSpy(deps, spy));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: true });
    expect(seen).toEqual([mailboxId, "abc123"]);
  });

  it("the replace carries the fingerprint and answers replaced", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const seen: unknown[] = [];
    const spy: Partial<ProfileImportService> = {
      replace: async (_ctx, id, body) => { seen.push(id, body.fingerprint); },
    };
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import/replace`, {
      bearer: s.token, body: JSON.stringify({ fingerprint: "abc123" }),
    }), withSpy(deps, spy));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replaced: true });
    expect(seen).toEqual([mailboxId, "abc123"]);
  });
});

describe("the real service, over HTTP, on the paths that need no mailbox fixture", () => {
  it("no found-marker ⇒ none — the cheap path a shell may ask once per mailbox per tab", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const res = await H(req("GET", `/mailboxes/${mailboxId}/profile-import`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
  });

  it("a cross-account mailbox id is a 404, before anything else happens", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const foreign = await seedMailbox(db, { accountId: other.accountId });
    const res = await H(req("GET", `/mailboxes/${foreign}/profile-import`, { bearer: s.token }), deps);
    expect(res.status).toBe(404);
  });

  it("an open question over a mailbox whose dial would fail is answered from the record — no dial", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    // Credentials exist and the connect fails — a provider outage, a rotated password or a
    // provider slower than one request. The suite-wide dial stub is re-spied to refuse and to
    // count, which wins because it is installed second (the helper's own documented pattern).
    const enc = await (await import("@trafficflow/services")).StaticKeyProvider
      .fromSecret(Buffer.alloc(32, 7)).encrypt("pw");
    const { mailboxCredentials } = await import("@trafficflow/db");
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "imap.example", port: 993, secure: true, user: "u" },
    });
    const { auditLog, PROFILE_FOUND_AUDIT_ACTION } = await import("@trafficflow/db");
    await db.insert(auditLog).values({
      accountId: s.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
      payload: {
        mailboxId, state: "found", fingerprint: "f".repeat(64), heldForImport: true,
        updatedAt: "2026-08-10T09:00:00.000Z", producer: { kind: "local", version: "0.9.3" },
        counts: { screener: 4, rules: 2, notifyRules: 0, tagNames: 1, awayResponder: 0 },
      },
      inverse: null,
    });
    const { ImapAdapter } = await import("@trafficflow/core/adapters/imap");
    const { vi } = await import("vitest");
    const connect = vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(new Error("connect ETIMEDOUT"));
    try {
      const res = await H(req("GET", `/mailboxes/${mailboxId}/profile-import`, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        state: "found", fingerprint: "f".repeat(64),
        counts: { screener: 4, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
      });
      expect(connect, "the card's question dialled the mailbox").not.toHaveBeenCalled();
    } finally {
      const { stubImapDial } = await import("./helpers.js");
      stubImapDial();
    }
  });

  it("Not now, then Replace: `declined` from the marker, then the question rests — no dial either way", async () => {
    // A credential row whose secret cannot be decrypted, so a dial on any of these reads could not start.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const { auditLog, mailboxCredentials, PROFILE_FOUND_AUDIT_ACTION } = await import("@trafficflow/db");
    await db.insert(mailboxCredentials).values({ mailboxId, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
    const fingerprint = "e".repeat(64);
    await db.insert(auditLog).values({
      accountId: s.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
      payload: {
        mailboxId, state: "found", fingerprint, heldForImport: true,
        updatedAt: "2026-08-10T09:00:00.000Z", producer: { kind: "local", version: "0.9.3" },
        counts: { screener: 4, rules: 2, notifyRules: 0, tagNames: 1, awayResponder: 1 },
      },
      inverse: null,
    });
    const post = (path: string) => H(req("POST", `/mailboxes/${mailboxId}/profile-import/${path}`, {
      bearer: s.token, body: JSON.stringify({ fingerprint }),
    }), deps);
    const get = async () => (await H(req("GET", `/mailboxes/${mailboxId}/profile-import`, { bearer: s.token }), deps)).json();

    expect((await post("decline")).status).toBe(200);
    expect(await get()).toEqual({
      state: "declined", fingerprint,
      updatedAt: "2026-08-10T09:00:00.000Z", producer: { kind: "local", version: "0.9.3" },
      counts: { screener: 4, rules: 2, notifyRules: 0, tags: 1, awayResponder: true, signature: false },
    });
    const replaced = await post("replace");
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ replaced: true });
    expect(await get()).toEqual({ state: "none" });
  });

  it("a replace that names no document is a 400 naming the field", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import/replace`, {
      bearer: s.token, body: "{}",
    }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("fingerprint");
  });

  it("a decline that names no subject is a 400 naming the field", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import/decline`, {
      bearer: s.token, body: "{}",
    }), deps);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("fingerprint");
  });
});
