import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { attachments as attachmentsTbl, mailboxCredentials } from "@trafficflow/db";
import { ServiceError } from "@trafficflow/services/mail";
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { makeImapProbe } from "../src/imap-probe.js";
import { imapDoorTimedOut } from "../src/imap-budget.js";
import { jsonResponse } from "../src/responses.js";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

/* @reads: packages/api/src/ packages/services/src/
   Walks both packages' source by paths built at runtime, so no landing pass selects this file when
   a producer there moves; the shape `reads-list.mjs` exists for. */

/**
 * ONE SPELLING OF THE WAIT (BYTE-ROUTE-429-HAS-NO-RETRY-AFTER). The envelope turns
 * `details.retryAfter` into `Retry-After`, and the byte door's and the probe door's `mailbox_busy`
 * wrote `retryAfterSeconds`, so their 429s carried no header. The producers now write the one key;
 * a census keeps a second spelling out of every `ServiceError` in both packages.
 */

const refusingAdmission = { acquire: async () => false, release: async () => undefined };

async function seeded() {
  const made = await makeDeps(FIXED_NOW);
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const { id: messageId, mailboxId } = await seedMessage(made.db, { accountId: s.accountId, folder: "INBOX" });
  const enc = await made.deps.keyProvider.encrypt("imap-pass");
  await made.db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "127.0.0.1", port: 1, secure: false, user: "u@wait.example" },
  });
  const [att] = await made.db.insert(attachmentsTbl).values({
    accountId: s.accountId, messageId, filename: "a.pdf", contentType: "application/pdf",
    sizeBytes: 10, inline: false, partId: "2",
  }).returning();
  (made.deps.services as unknown as { imapAdmission: unknown }).imapAdmission = refusingAdmission;
  return { ...made, s, attId: att!.id };
}

async function waited(res: Response): Promise<{ status: number; code?: string; header: string | null; details: unknown }> {
  const body = await res.json() as { error?: { code?: string; details?: unknown } };
  return { status: res.status, code: body.error?.code, header: res.headers.get("retry-after"), details: body.error?.details };
}

describe("a 429 names its wait where a client reads it", () => {
  it("the byte door's mailbox_busy carries Retry-After equal to details.retryAfter", async () => {
    const w = await seeded();
    const app = createApp(apiRoutes);
    const res = await app.handle(req("GET", `/attachments/${w.attId}`, { bearer: w.s.token }), { ...w.deps, session: null, idempotency: null });
    const a = await waited(res);
    expect({ status: a.status, code: a.code }).toEqual({ status: 429, code: "mailbox_busy" });
    expect(a.details).toEqual({ retryAfter: 10 });
    expect(a.header).toBe("10");
  });

  it("the probe door's mailbox_busy does too", async () => {
    const w = await seeded();
    const app = createApp([{
      method: "POST", pattern: "/probe", cost: "unauthenticated", options: { public: true },
      handler: async (_req: Request, deps: ApiDeps) => {
        await makeImapProbe(deps)({ accountId: w.s.accountId, address: "u@wait.example",
          imap: { host: "127.0.0.1", port: 1, user: "u@wait.example", pass: "p" } });
        return jsonResponse({});
      },
    }] as never);
    const a = await waited(await app.handle(new Request("http://localhost/probe", { method: "POST" }), { ...w.deps, session: null, idempotency: null }));
    expect({ status: a.status, code: a.code, details: a.details }).toEqual({ status: 429, code: "mailbox_busy", details: { retryAfter: 10 } });
    expect(a.header).toBe("10");
  });

  it("the door timeout keeps its wait under the one key, and its retryable 504 names it in the header", async () => {
    // A refusal that invites the retry says when (the send's re-arm made this the envelope's rule):
    // the 504 is retryable, so its `details.retryAfter` reaches `Retry-After` as the 429's does.
    const timedOut = imapDoorTimedOut(20_000);
    expect({ details: timedOut.details, retryable: timedOut.retryable }).toEqual({ details: { retryAfter: 5 }, retryable: true });
    const app = createApp([{
      method: "GET", pattern: "/slow", cost: "unauthenticated", options: { public: true },
      handler: async () => { throw imapDoorTimedOut(20_000); },
    }] as never);
    const w = await seeded();
    const a = await waited(await app.handle(new Request("http://localhost/slow"), { ...w.deps, session: null, idempotency: null }));
    expect({ status: a.status, header: a.header }).toEqual({ status: 504, header: "5" });
  });

  it("a refusal that says it is not retryable names no wait, even at 429: the header never contradicts the flag", async () => {
    // Once the send's final answer to a full cap: `retryable: false` beside a `Retry-After: 2`.
    const app = createApp([{
      method: "GET", pattern: "/final", cost: "unauthenticated", options: { public: true },
      handler: async () => { throw new ServiceError("mailbox_busy", 429, "busy", { retryAfter: 2 }, false); },
    }] as never);
    const w = await seeded();
    const a = await waited(await app.handle(new Request("http://localhost/final"), { ...w.deps, session: null, idempotency: null }));
    expect({ status: a.status, code: a.code, header: a.header }).toEqual({ status: 429, code: "mailbox_busy", header: null });
  });
});

describe("no ServiceError spells the wait a second way", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  function sources(rel: string): { rel: string; text: string }[] {
    const out: { rel: string; text: string }[] = [];
    const walk = (r: string) => {
      for (const name of readdirSync(join(ROOT, r))) {
        const p = `${r}/${name}`;
        if (statSync(join(ROOT, p)).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) out.push({ rel: p, text: scan.withoutComments(readFileSync(join(ROOT, p), "utf8")) });
      }
    };
    walk(rel);
    return out;
  }
  const files = [...sources("packages/api/src"), ...sources("packages/services/src")];
  /** admin-staff's `{ ok, status, retryAfterSeconds }` is its own route's body, not a ServiceError's details. */
  const ADMITTED = new Set(["packages/api/src/routes/admin-staff.ts"]);

  it("reads real sources, and finds the producers of the one key", () => {
    expect(files.length, "the walk read nothing").toBeGreaterThan(100);
    const producers = files.filter((f) => /\bretryAfter\s*[:,}]/.test(f.text)).map((f) => f.rel);
    expect(producers).toEqual(expect.arrayContaining([
      "packages/api/src/attachments-adapter.ts", "packages/api/src/imap-probe.ts",
      "packages/api/src/imap-budget.ts", "packages/services/src/auth/auth-service.ts",
    ]));
  });

  it("no file but the admitted one spells retryAfterSeconds", () => {
    const spelled = files.filter((f) => /\bretryAfterSeconds\b/.test(f.text) && !ADMITTED.has(f.rel)).map((f) => f.rel);
    expect(spelled).toEqual([]);
    expect(files.some((f) => ADMITTED.has(f.rel) && /\bretryAfterSeconds\b/.test(f.text)), "the admitted file moved; the list is stale").toBe(true);
  });
});
