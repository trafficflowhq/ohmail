import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountSettings, contacts, rules as rulesTable, workflowRuns, workflows } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import {
  CONTACTS_QUERY_MAX_CHARS, DRAFT_MAX_RECIPIENTS, DRAFT_SUBJECT_MAX_CHARS, KB_MAX_TAGS,
  RECIPIENT_NAME_MAX_CHARS, SEARCH_QUERY_MAX_CHARS, SEED_MAX_ADDRESSES, SEED_SCAN_LIMIT,
  SEND_ATTACHMENT_FIELD_MAX_CHARS, THREAD_MERGE_MAX_IDS,
} from "@trafficflow/services/mail";
import { MAX_WORKFLOW_STEPS } from "@trafficflow/core/mail";
import {
  PROFILE_DOC_MAX_BYTES, readOrganizerProfile,
} from "@trafficflow/core/adapters/organizer-profile";
import {
  INGEST_DISPLAY_NAME_MAX_CHARS, INGEST_SUBJECT_MAX_CHARS, ingestDisplayName, ingestSubject,
} from "@trafficflow/core/adapters/imap";
import { SETTINGS_MAX_MAILBOX_ENTRIES } from "../src/routes/consent.js";
import { PASSWORD_MAX_LENGTH } from "../../services/src/auth/auth-service.js";
import {
  FIXED_NOW, makeDeps, req, seedMailbox, seedMessage, seedSession, seedThread,
} from "./helpers.js";

/**
 * the hostile value driven through the REAL route, per bound.
 *
 * The census next door proves every input has been looked at. This file proves the bounds
 * actually fire, from the outside, on the request a caller would send.
 *
 * ── WHAT AN HONEST REFUSAL LOOKS LIKE, AND WHY EACH ASSERTION IS HERE ─────────────────────
 *
 * The review found the quiet failure mode as well as the loud one: `clampLimit` returning `NaN`
 * made the database read the whole table and the response return a page of NOTHING, so the
 * caller saw "no results" for a request that had cost the most it could. **A silent empty page
 * is the failure, not the fix.** So every case below asserts three things and not one:
 *
 *   1. the status is a refusal (400 or 413), never a 200 with an empty body and never a 500;
 *   2. the refusal MESSAGE names the limit, so the caller can narrow to it; and
 *   3. the same request exactly AT the ceiling still succeeds, so the bound refuses nothing real.
 *
 * ── THE MUTATIONS, EACH WATCHED FAIL AND RESTORED ────────────────────────────────────────
 *
 *  · `validAddresses`      — delete the `DRAFT_MAX_RECIPIENTS` block → the over-long recipient draft is
 *                            stored with a 201 and every send of it issues 500 `RCPT TO`.
 *  · `merge`               — delete the `THREAD_MERGE_MAX_IDS` block → the over-long thread merge takes
 *                            200 `FOR UPDATE` locks and answers 404 (ids that do not exist),
 *                            which is a refusal for the wrong reason at the wrong cost.
 *  · `validateSteps`       — delete the `MAX_WORKFLOW_STEPS` block → the over-long workflow is
 *                            stored with a 201.
 *  · `search`              — delete the `SEARCH_QUERY_MAX_CHARS` block → the over-long `q`
 *                            reaches `word_similarity` and the assertion sees 200, not 400.
 *  · `ContactsService.list`— delete the `CONTACTS_QUERY_MAX_CHARS` block → the long `q` becomes a
 *                            100 KB ILIKE pattern and the assertion sees 200.
 *  · `validTags`           — delete the `KB_MAX_TAGS` block → thousands of tags are stored as one jsonb
 *                            column and echoed by every retrieval.
 *  · `seedAddresses`       — delete the `SEED_MAX_ADDRESSES` block → the oversized list is folded
 *                            into a Set before the intersection bounds it.
 *  · `applyConsentSettings`— delete either entry-count block → the map's entries each become a
 *                            statement inside one transaction.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** The refusal shape every case below asserts: a status, a code, and the number to narrow to. */
async function expectRefusal(
  res: Response, statuses: number[], limit: number | string,
): Promise<{ code: string; message: string }> {
  const body = await res.json() as { error?: { code?: string; message?: string } };
  const code = body.error?.code ?? "";
  const message = body.error?.message ?? "";
  expect(statuses, `status ${res.status} (${code}: ${message})`).toContain(res.status);
  // Never a 500: a bound that surfaces as an internal error is a bound the caller cannot act on.
  expect(res.status).toBeLessThan(500);
  expect(message, "the refusal must name the limit").toContain(String(limit));
  return { code, message };
}

const addresses = (n: number): Array<{ address: string }> =>
  Array.from({ length: n }, (_, i) => ({ address: `p${i}@example.com` }));

describe("POST /drafts — the recipient list reaches Nodemailer entry by entry", () => {
  it("refuses a `to` list over the ceiling, naming it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const res = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId: mb, to: addresses(DRAFT_MAX_RECIPIENTS + 1) }),
    }), deps);

    const { code } = await expectRefusal(res, [413], DRAFT_MAX_RECIPIENTS);
    expect(code).toBe("payload_too_large");
  });

  it("stores a draft exactly AT the ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const res = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId: mb, to: addresses(DRAFT_MAX_RECIPIENTS) }),
    }), deps);

    expect(res.status).toBe(201);
  });

  it("bounds `cc` and `bcc` too — the ceiling is per field, so all three carry it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    for (const field of ["cc", "bcc"] as const) {
      const res = await H(req("POST", "/drafts", {
        bearer: s.token,
        body: JSON.stringify({ mailboxId: mb, [field]: addresses(DRAFT_MAX_RECIPIENTS + 1) }),
      }), deps);
      const { message } = await expectRefusal(res, [413], DRAFT_MAX_RECIPIENTS);
      expect(message, "the refusal must name WHICH field").toContain(field);
    }
  });
});

describe("POST /threads/merge — every id costs a row lock held to commit", () => {
  it("refuses an over-long threadIds list, naming the ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const threadIds = Array.from({ length: THREAD_MERGE_MAX_IDS + 1 }, () => randomUUID());

    const res = await H(req("POST", "/threads/merge", {
      bearer: s.token, body: JSON.stringify({ threadIds }),
    }), deps);

    const { code } = await expectRefusal(res, [413], THREAD_MERGE_MAX_IDS);
    expect(code).toBe("payload_too_large");
  });

  it("refuses a malformed thread id as 400, not a 500 from a uuid column", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(req("POST", "/threads/merge", {
      bearer: s.token, body: JSON.stringify({ threadIds: ["not-a-uuid", randomUUID()] }),
    }), deps);

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_failed");
  });

  it("still merges a real pair — the lower bound and the upper bound do not fight", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const a = await seedThread(db, { accountId: s.accountId, subject: "one" });
    const b = await seedThread(db, { accountId: s.accountId, subject: "two" });
    await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: b, folder: "INBOX" });

    const res = await H(req("POST", "/threads/merge", {
      bearer: s.token, body: JSON.stringify({ threadIds: [a, b] }),
    }), deps);

    expect(res.status).toBe(200);
  });
});

describe("POST /workflows — one run executes every step on the shared worker", () => {
  const wf = (steps: number): string => JSON.stringify({
    name: "w",
    trigger: { kind: "manual" },
    steps: Array.from({ length: steps }, () => ({ tool: "file_message", args: { folder: "INBOX" } })),
  });

  it("refuses a step list over the ceiling, naming it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(req("POST", "/workflows", { bearer: s.token, body: wf(MAX_WORKFLOW_STEPS + 1) }), deps);

    await expectRefusal(res, [400, 413], MAX_WORKFLOW_STEPS);
  });

  it("stores a workflow exactly AT the ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(req("POST", "/workflows", { bearer: s.token, body: wf(MAX_WORKFLOW_STEPS) }), deps);

    expect(res.status).toBe(201);
  });

  it("PATCH is bounded too — the update path is a second door onto the same column", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const created = await H(req("POST", "/workflows", { bearer: s.token, body: wf(1) }), deps);
    const { id } = await created.json() as { id: string };

    const res = await H(req("PATCH", `/workflows/${id}`, {
      bearer: s.token, body: wf(MAX_WORKFLOW_STEPS + 1),
    }), deps);

    await expectRefusal(res, [400, 413], MAX_WORKFLOW_STEPS);
  });
});

describe("GET /search — `q` reaches a per-row trigram comparison", () => {
  it("refuses a term over the ceiling with a 400 that names it — not an empty page", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const q = "a".repeat(SEARCH_QUERY_MAX_CHARS + 1);

    const res = await H(req("GET", `/search?q=${q}`, { bearer: s.token }), deps);

    const { code } = await expectRefusal(res, [400], SEARCH_QUERY_MAX_CHARS);
    expect(code).toBe("validation_failed");
  });

  it("serves a term exactly AT the ceiling, trailing whitespace included", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(req("GET", `/search?q=${"a".repeat(SEARCH_QUERY_MAX_CHARS)}`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);

    // …and one with a trailing space, which trims back to the ceiling. The raw check allows
    // exactly ONE character over, and this is the case it allows it for — the ceiling is measured
    // on the RAW length, not the trimmed one, with a character of slack.
    const padded = await H(
      req("GET", `/search?q=${"a".repeat(SEARCH_QUERY_MAX_CHARS)}%20`, { bearer: s.token }), deps,
    );
    expect(padded.status).toBe(200);
  });

  it("refuses a term whose EXCESS is only whitespace-separated — never silently truncates it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    /**
     * The case the slice-then-trim version got wrong, and the reason the raw length decides.
     *
     * `<MAX chars> <more text>` sliced to `MAX + 1`, which is the MAX characters plus the
     * boundary space; trimming removed the space and left exactly `MAX`, so it passed — and the
     * search then ran against a PREFIX of what the caller typed, with a 200 and nothing on the
     * wire to say so. A silent truncation produced by the guard against silent truncation.
     */
    const q = `${"a".repeat(SEARCH_QUERY_MAX_CHARS)} different-tail`;
    const res = await H(req("GET", `/search?q=${encodeURIComponent(q)}`, { bearer: s.token }), deps);

    const { code } = await expectRefusal(res, [400], SEARCH_QUERY_MAX_CHARS);
    expect(code).toBe("validation_failed");
  });

  it("does NOT bound the facet filters — they are equality, and a ceiling refused our own facet", async () => {
    const { db, deps } = await makeDeps();
    const s2 = await seedSession(db, { now: FIXED_NOW });
    // `messages.from_address` is stored unbounded, so `facets()` can hand the client a sender
    // longer than any ceiling. A bound here answered 400 to a facet this API had just emitted.
    const long = "f".repeat(1000);

    for (const field of ["folder", "sender"] as const) {
      const res = await H(req("GET", `/search?q=hello&${field}=${long}`, { bearer: s2.token }), deps);
      expect(res.status, `${field} must not be refused on length`).toBe(200);
    }
  });

});

describe("GET /contacts — `q` becomes an unanchored ILIKE pattern over every contact row", () => {
  it("refuses a term over the ceiling, naming it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(
      req("GET", `/contacts?q=${"a".repeat(CONTACTS_QUERY_MAX_CHARS + 1)}`, { bearer: s.token }), deps,
    );

    await expectRefusal(res, [400], CONTACTS_QUERY_MAX_CHARS);
  });

  it("serves a term exactly AT the ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(
      req("GET", `/contacts?q=${"a".repeat(CONTACTS_QUERY_MAX_CHARS)}`, { bearer: s.token }), deps,
    );

    expect(res.status).toBe(200);
  });

  it("reads `_` and `%` in the term as typed, never as wildcards", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const address of ["a_b@site.example", "axb@site.example", "50%off@site.example", "500ff@site.example"]) {
      await db.insert(contacts).values({ accountId: s.accountId, address });
    }
    const listed = async (q: string): Promise<string[]> => {
      const res = await H(req("GET", `/contacts?q=${encodeURIComponent(q)}`, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: Array<{ addresses: string[] }> }).items.flatMap((c) => c.addresses);
    };
    expect({ underscore: await listed("a_b"), percent: await listed("50%o") })
      .toEqual({ underscore: ["a_b@site.example"], percent: ["50%off@site.example"] });
  });
});

describe("POST /kb — the tag list is stored whole and echoed by every retrieval", () => {
  const entry = (tags: string[]): string => JSON.stringify({ title: "t", content: "c", tags });

  it("refuses more tags than the ceiling, naming it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const tags = Array.from({ length: KB_MAX_TAGS + 1 }, (_, i) => `t${i}`);

    const res = await H(req("POST", "/kb", { bearer: s.token, body: entry(tags) }), deps);

    await expectRefusal(res, [400, 413], KB_MAX_TAGS);
  });

  it("stores an entry exactly AT the ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const tags = Array.from({ length: KB_MAX_TAGS }, (_, i) => `t${i}`);

    const res = await H(req("POST", "/kb", { bearer: s.token, body: entry(tags) }), deps);

    expect(res.status).toBe(201);
  });
});

describe("the consent surface — one write per entry, inside one transaction", () => {
  it("POST /consent/seed refuses an unbounded address list before it folds it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // A coarse ceiling deliberately far above any review's fan-out: it exists to stop the
    // unbounded fold, not to second-guess what the review offered. Short addresses, so the
    // request door's byte ceiling is nowhere near — only the COUNT can refuse this.
    const list = Array.from({ length: SEED_MAX_ADDRESSES + 1 }, (_, i) => `p${i}@e.example`);

    const res = await H(req("POST", "/consent/seed", {
      bearer: s.token, body: JSON.stringify({ addresses: list }),
    }), deps);

    await expectRefusal(res, [413], SEED_MAX_ADDRESSES);
  });

  it("…and a list the size of a real review is served — the ceiling is not the scan limit", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // One sent message contributes every distinct recipient on it, so a review built from
    // `SEED_SCAN_LIMIT` messages can legitimately offer MORE addresses than that. A ceiling
    // derived from the message count would refuse this product's own review.
    const list = Array.from({ length: SEED_SCAN_LIMIT * 2 }, (_, i) => `p${i}@e.example`);

    const res = await H(req("POST", "/consent/seed", {
      bearer: s.token, body: JSON.stringify({ addresses: list }),
    }), deps);

    expect(res.status).toBe(200);
  });

  it("PATCH /consent/settings refuses a per-mailbox map with more entries than any plan allows", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const many = Object.fromEntries(
      Array.from({ length: SETTINGS_MAX_MAILBOX_ENTRIES + 1 }, () => [randomUUID(), true]),
    );

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ folderMailboxes: many }),
    }), deps);

    await expectRefusal(res, [413], SETTINGS_MAX_MAILBOX_ENTRIES);
  });

  it("…and the signatures map on the same route, which is the same shape reaching the same loop", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const many = Object.fromEntries(
      Array.from({ length: SETTINGS_MAX_MAILBOX_ENTRIES + 1 }, () => [randomUUID(), "sig"]),
    );

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ signatures: many }),
    }), deps);

    await expectRefusal(res, [413], SETTINGS_MAX_MAILBOX_ENTRIES);
  });
});

/**
 * `MAX_WORKFLOW_STEPS` re-checked on the STORED array at enqueue.
 *
 * A write-time ceiling closes the door for rows created after it and closes nothing for rows that
 * already exist — and one `POST /workflows/:id/run` makes the shared worker execute every element
 * of whatever is stored. So the stored value is treated as an input in its own right.
 *
 * The row is written straight to the table here, past `validateSteps`, which is exactly the
 * situation the guard exists for: a workflow stored before the ceiling shipped.
 *
 * Watched fail and restored: delete the `stored.length > MAX_WORKFLOW_STEPS` block in
 * `assertRunnable` and this answers 202 with a run enqueued.
 */
describe("POST /workflows/:id/run — a workflow stored before the ceiling cannot run", () => {
  it("refuses at ENQUEUE, naming the ceiling, and enqueues nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const [wf] = await db.insert(workflows).values({
      accountId: s.accountId,
      name: "legacy",
      trigger: { kind: "manual" },
      steps: Array.from({ length: MAX_WORKFLOW_STEPS + 5 }, () => ({ tool: "file_message", args: { folder: "INBOX" } })),
      enabled: true,
    }).returning({ id: workflows.id });

    const res = await H(req("POST", `/workflows/${wf!.id}/run`, {
      bearer: s.token, headers: { "idempotency-key": randomUUID() },
    }), deps);

    const { code } = await expectRefusal(res, [409], MAX_WORKFLOW_STEPS);
    expect(code).toBe("workflow_too_many_steps");
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.accountId, s.accountId));
    expect(runs, "nothing was enqueued").toHaveLength(0);
  });

  it("a stored workflow AT the ceiling still runs", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const [wf] = await db.insert(workflows).values({
      accountId: s.accountId,
      name: "fine",
      trigger: { kind: "manual" },
      steps: Array.from({ length: MAX_WORKFLOW_STEPS }, () => ({ tool: "file_message", args: { folder: "INBOX" } })),
      enabled: true,
    }).returning({ id: workflows.id });

    const res = await H(req("POST", `/workflows/${wf!.id}/run`, {
      bearer: s.token, headers: { "idempotency-key": randomUUID() },
    }), deps);

    expect(res.status).toBe(202);
  });
});

/**
 * THE SHARED LIST CURSOR — the one input every keyset-paginated route on this API accepts.
 *
 * `decodeListCursor` was `Buffer.from(cursor, "base64url").toString("utf8")` and nothing else.
 * Node's base64 decoder never throws — it discards what it cannot read — so `?cursor=eA` decoded
 * to the string `"x"`, which every caller binds straight against a `uuid` column: Postgres
 * answers 22P02 and the request is a **500 for a plainly bad query string**. The input-bounds
 * census recorded every `#cursor` as `identifier`, a disposition that claims a shape check, and
 * writing that claim down is what found it.
 *
 * The BOTH-SHAPES case is here because the first fix accepted a bare uuid only, and five routes
 * encode `` `${millis}:${uuid}` `` — it would have turned their second page into a 400. That is
 * the failure a bound introduces when it is written against a docstring instead of the encoders.
 *
 * Watched fail and restored: remove the `CURSOR_UUID` test from `decodeListCursor` and the
 * hostile cases answer 500 instead of 400 — measured as `/contacts ?cursor=eA → internal:
 * expected 500 to be 400`.
 */
describe("a malformed ?cursor= is a 400 on every paginated route, never a 500", () => {
  const HOSTILE = [
    "eA",                                   // decodes to "x" — the measured 22P02
    "bm90LWEtdXVpZA",                       // "not-a-uuid"
    "!!!!",                                 // not base64url at all
    "a".repeat(200),                        // over the length ceiling, refused before the decode
  ];
  // One per family: a bare-id encoder, a keyset encoder, and a third table.
  const ROUTES = ["/contacts", "/messages?view=imbox", "/kb", "/snippets", "/workflow-runs"];

  it("refuses every hostile cursor on every family", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    for (const route of ROUTES) {
      for (const cursor of HOSTILE) {
        const sep = route.includes("?") ? "&" : "?";
        const res = await H(req("GET", `${route}${sep}cursor=${cursor}`, { bearer: s.token }), deps);
        const body = await res.json() as { error?: { code?: string } };
        expect(res.status, `${route} ?cursor=${cursor.slice(0, 12)} → ${body.error?.code}`).toBe(400);
        expect(body.error?.code).toBe("validation_failed");
      }
    }
  });

  it("still accepts BOTH shapes this codebase encodes — the bare id and the keyset pair", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    for (let i = 0; i < 3; i++) {
      await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX" });
    }
    const b64 = (v: string): string => Buffer.from(v, "utf8").toString("base64url");

    // `/kb` encodes the bare entity id; `/messages` encodes `${millis}:${id}`. A validator
    // written against this module's header — "a list cursor encodes the last entity id" —
    // accepts the first and 400s the second, on five routes.
    const bare = await H(req("GET", `/kb?cursor=${b64(randomUUID())}`, { bearer: s.token }), deps);
    expect(bare.status).toBe(200);

    const keyset = await H(
      req("GET", `/messages?view=imbox&cursor=${b64(`${Date.now()}:${randomUUID()}`)}`, { bearer: s.token }),
      deps,
    );
    expect(keyset.status).toBe(200);
  });
});

/**
 * EVERY `identifier` THE CENSUS CLAIMS IS SHAPE-CHECKED, driven with a value that is not one.
 *
 * `identifier` is a disposition whose whole content is *"the shape test is the bound"* — a value
 * that must be a uuid cannot be long, and one that is not one is refused rather than handed to a
 * `uuid` column. Writing that claim down is what found it false for five parameters: `folderId`,
 * `workflowId`, `mid`, `mailboxId` and the sync snapshot cursor's `i` all reached their column
 * with no test at all, so Postgres answered 22P02 and the caller got **500 for a bad query
 * string**.
 *
 * Watched fail and restored: remove any one `requireUuid` in `packages/services/src/ids.ts`'s
 * callers and its case here answers 500 instead of 400.
 */
describe("a malformed identifier is a 400, never a 500 from a uuid column", () => {
  const CASES: Array<[string, string]> = [
    ["view=folder&folderId", "/messages?view=folder&folderId=not-a-uuid"],
    ["workflowId", "/workflow-runs?workflowId=not-a-uuid"],
    ["junk mailboxId", "/screener/junk/body?mailboxId=not-a-uuid&uid=1&uidValidity=1"],
  ];

  /**
   * The Junk routes gate on folders being enabled before anything else, so without this the
   * shape check is never reached and the case would pass on a 409 it never exercised — a green
   * that proves nothing, which is the shape this slice is about.
   */
  const enableFolders = (db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string) =>
    db.insert(accountSettings).values({ accountId, foldersEnabledAt: FIXED_NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { foldersEnabledAt: FIXED_NOW } });

  it("refuses each one with a validation error", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await enableFolders(db, s.accountId);

    for (const [name, path] of CASES) {
      const res = await H(req("GET", path, { bearer: s.token }), deps);
      const body = await res.json() as { error?: { code?: string } };
      expect(res.status, `${name} → ${body.error?.code}`).toBe(400);
      expect(body.error?.code, name).toBe("validation_failed");
    }
  });

  it("refuses an IMAP uid or epoch outside the protocol's 32 bits", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await enableFolders(db, s.accountId);
    const mb = await seedMailbox(db, { accountId: s.accountId });

    // `1e100` IS an integer to JavaScript, so the route's own `Number.isInteger` check passed it
    // and it was written into a FETCH command on a socket to somebody's mail server. RFC 3501
    // makes UID and UIDVALIDITY unsigned 32-bit.
    for (const q of [
      `mailboxId=${mb}&uid=1e100&uidValidity=1`,
      `mailboxId=${mb}&uid=1&uidValidity=${"9".repeat(40)}`,
    ]) {
      const res = await H(req("GET", `/screener/junk/body?${q}`, { bearer: s.token }), deps);
      const body = await res.json() as { error?: { code?: string } };
      expect(res.status, `${q} → ${body.error?.code}`).toBe(400);
    }
  });

  it("refuses an out-of-protocol uid on the RESCUE seam too, before it writes anything", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await enableFolders(db, s.accountId);
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // The second door onto the same FETCH/MOVE. `junkBody` got the guard and this did not, which
    // is what a per-route check produces. And `allow` COMMITS a rule change, so the order matters
    // as much as the presence: a refusal after it would leave the user's screening changed by a
    // request that then failed.
    const res = await H(req("POST", "/screener/junk/rescue", {
      bearer: s.token,
      body: JSON.stringify({
        mailboxId: mb, uid: 1e100, uidValidity: "1", allow: { sender: "spam@example.com" },
      }),
    }), deps);

    expect(res.status).toBe(400);
    const rules = await db.select().from(rulesTable).where(eq(rulesTable.accountId, s.accountId));
    expect(rules, "nothing was written before the refusal").toHaveLength(0);
  });

  it("refuses a hand-built snapshot cursor whose keyset id is not an id", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // Every other field of this cursor is well-formed; `i` was checked only for being a non-empty
    // string, and it is bound against `messages.id`.
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, s: "1", d: null, i: "x", n: 0 }), "utf8",
    ).toString("base64url");

    const res = await H(req("GET", `/sync/snapshot?cursor=${cursor}`, { bearer: s.token }), deps);

    // 410 is this route's own answer for a malformed cursor — a refusal, not a 500.
    expect([400, 410]).toContain(res.status);
    expect(res.status).toBeLessThan(500);
  });

  it("refuses a junk-window cursor whose KEY is not a mailbox id", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await enableFolders(db, s.accountId);
    // The key is compared against `mailboxes.id` downstream; it was untyped, so a cursor could
    // name any string as a mailbox.
    const cursor = Buffer.from(JSON.stringify({ "not-a-uuid": { v: "1", s: 1 } }), "utf8")
      .toString("base64url");

    const res = await H(req("GET", `/screener/junk?cursor=${cursor}`, { bearer: s.token }), deps);

    expect(res.status).toBe(400);
  });

  it("refuses an oversized junk-window cursor before it decodes or loops it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await enableFolders(db, s.accountId);
    // A base64 JSON OBJECT, not an id: one entry per mailbox, and it was bounded by nothing.
    // Big enough to break the WIRE ceiling, which is the bound this case is for.
    const many = Object.fromEntries(
      Array.from({ length: 3000 }, () => [randomUUID(), { v: "1", s: 1 }]),
    );
    const cursor = Buffer.from(JSON.stringify(many), "utf8").toString("base64url");

    const res = await H(req("GET", `/screener/junk?cursor=${cursor}`, { bearer: s.token }), deps);

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_failed");
  });
});

/**
 * THE THREE WAYS A NEW BOUND CAN REFUSE SOMETHING THE PRODUCT ITSELF PRODUCES.
 *
 * Every case here failed during this slice and was caught by a review round or by the suite, not
 * by reading. They are kept together because they are one lesson: a ceiling written from a
 * docstring rather than from the code that produces the value refuses the code that produces it.
 */
describe("the bounds refuse nothing this product itself emits", () => {
  it("a message dated before 1970 still pages — the keyset cursor may carry a negative timestamp", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // `messages.date` is the sender's own `Date:` header and carries no non-negative constraint;
    // imported archives routinely hold pre-epoch mail. `getTime()` is then negative and the
    // encoder writes `-<millis>:<uuid>`, which a digits-only cursor grammar refuses — page one
    // hands out a cursor page two rejects.
    for (let i = 0; i < 3; i++) {
      await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb, folder: "INBOX",
        date: new Date(Date.UTC(1969, 5, 20 - i)),
      });
    }

    const first = await H(req("GET", "/messages?view=imbox&limit=2", { bearer: s.token }), deps);
    expect(first.status).toBe(200);
    const page1 = await first.json() as { items: unknown[]; nextCursor: string | null };
    expect(page1.nextCursor).toBeTruthy();
    // The proof that this case exercises what it claims: the cursor really is the negative form.
    expect(Buffer.from(page1.nextCursor!, "base64url").toString("utf8")).toMatch(/^-\d+:/);

    const second = await H(
      req("GET", `/messages?view=imbox&limit=2&cursor=${page1.nextCursor}`, { bearer: s.token }), deps,
    );
    expect(second.status).toBe(200);
  });

  it("a 1 000-character PLAIN BODY is stored — the subject ceiling is the subject's alone", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // The subject ceiling was briefly inside the SHARED string validator, so `body` inherited it
    // — and a rich draft of the same length was accepted, because `richBody` is a different path.
    // A limit that depends on the format the user chose is a bug with a number in it.
    const res = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId: mb, body: "b".repeat(1000) }),
    }), deps);

    expect(res.status).toBe(201);
  });

  it("a long inherited SUBJECT is stored — 998 is a line limit, not a subject maximum", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // A received subject may legally be folded across lines and so exceed 998; `replySubject`
    // inherits it verbatim, so a 998 ceiling refused the first autosave of a reply to real mail.
    const res = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId: mb, subject: "s".repeat(2000) }),
    }), deps);

    expect(res.status).toBe(201);

    // …and the ceiling still exists.
    const over = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId: mb, subject: "s".repeat(DRAFT_SUBJECT_MAX_CHARS + 1) }),
    }), deps);
    await expectRefusal(over, [400, 413], DRAFT_SUBJECT_MAX_CHARS);
  });

  it("a junk cursor naming far more mailboxes than a plan allows still pages", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await db.insert(accountSettings).values({ accountId: s.accountId, foldersEnabledAt: FIXED_NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { foldersEnabledAt: FIXED_NOW } });
    // The self-host imposes NO mailbox count limit, and `listJunk` mints one cursor entry per read
    // lane — so a ceiling derived from "the account's mailbox count" refuses a cursor this
    // function had just handed out. Two review rounds moved that threshold up twice
    // before it was removed: what is left is a WIRE ceiling, and this is well inside it.
    const wide = Object.fromEntries(
      Array.from({ length: 1500 }, () => [randomUUID(), { v: "1", s: 1 }]),
    );
    const accepted = Buffer.from(JSON.stringify(wide), "utf8").toString("base64url");

    const ok = await H(req("GET", `/screener/junk?cursor=${accepted}`, { bearer: s.token }), deps);
    expect(ok.status).toBe(200);

    /**
     * AND THE CURSOR IS ACTUALLY PARSED, which a status alone does not show.
     *
     * This account has no mailboxes, so an empty 200 is also what a handler that IGNORED the
     * cursor entirely would answer — the first version of this case asserted only that and would
     * have passed with the parsing removed. A malformed cursor of the same size answering 400 is
     * the difference: it can only come from a parser that read this parameter.
     */
    const malformed = Buffer.from(
      JSON.stringify({ ...wide, "not-a-uuid": { v: "1", s: 1 } }), "utf8",
    ).toString("base64url");
    const refused = await H(req("GET", `/screener/junk?cursor=${malformed}`, { bearer: s.token }), deps);
    expect(refused.status, "the cursor is parsed, not ignored").toBe(400);
  });
});

/**
 * THE TWO CURSOR GRAMMARS ARE NOT INTERCHANGEABLE, and one shared grammar made them so.
 *
 * Accepting both shapes everywhere looked like generosity and was the same 22P02 the validator
 * exists to stop, reintroduced: a keyset cursor sent to a bare-id route decoded to
 * `"1712…:<uuid>"` and was bound against a `uuid` column. A cursor is only ever handed out by one
 * route family and only ever meaningful there.
 *
 * Watched fail and restored: make `decodeListCursor` accept the keyset shape as well and the
 * first case answers 500.
 */
describe("a cursor from the wrong route family is refused, not bound to a uuid column", () => {
  const b64 = (v: string): string => Buffer.from(v, "utf8").toString("base64url");

  it("a KEYSET cursor on a bare-id route is a 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const tuple = b64(`${Date.now()}:${randomUUID()}`);

    for (const route of ["/contacts", "/kb", "/snippets"]) {
      const res = await H(req("GET", `${route}?cursor=${tuple}`, { bearer: s.token }), deps);
      const body = await res.json() as { error?: { code?: string } };
      expect(res.status, `${route} → ${body.error?.code}`).toBe(400);
    }
  });

  it("a timestamp outside `Date`'s own range is refused before it reaches a timestamptz cast", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // Sixteen digits, so a digit-count grammar accepts it — and it is not a time: `new Date()`
    // gives `Invalid Date` and the cast raises rather than paging.
    const res = await H(
      req("GET", `/messages?view=imbox&cursor=${b64(`9999999999999999:${randomUUID()}`)}`, { bearer: s.token }),
      deps,
    );

    expect(res.status).toBe(400);
    expect(res.status).toBeLessThan(500);
  });
});

/**
 * The last two caller-chosen values a review round found reaching a query and a decoder
 * unchecked. Both were recorded by the census as bounded before they were.
 */
describe("the two values the census called bounded before they were", () => {
  it("`minSizeBytes` is checked before it reaches a bigint predicate", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    // Declared `number` in `FilesFilter` and arriving from `JSON.parse`, so the type says nothing
    // at runtime: a string reached the `gte` as 22P02 and `1e30` as an out-of-range bigint, both
    // 500s for a plainly bad request.
    for (const minSizeBytes of ["x", 1e30, -1, 1.5]) {
      const res = await H(req("POST", "/files/download-all", {
        bearer: s.token, body: JSON.stringify({ filter: { minSizeBytes } }),
      }), deps);
      const body = await res.json() as { error?: { code?: string } };
      expect(res.status, `minSizeBytes=${String(minSizeBytes)} → ${body.error?.code}`).toBe(400);
    }
  });

  it("`?since=` and the snapshot cursor are refused rather than decoded and parsed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // ENCODED, not raw. `"1".repeat(50_000)` is itself base64url, so it decodes to binary that
    // fails the digit test whatever the length guard does — a hostile value that never reached
    // the thing it was aimed at. The cursor has to decode to tens of thousands of DIGITS.
    const huge = Buffer.from("9".repeat(50_000), "utf8").toString("base64url");

    /**
     * `?since=` was fully base64-decoded, regex-scanned end to end and handed to `BigInt`, which
     * is superlinear in its digit count. The census called it an `identifier` — a disposition
     * whose whole content is that the shape test is the bound — and there was no shape test that
     * bounded anything: `^\d+$` matches a string of tens of thousands of digits.
     *
     * ── WHAT THIS CASE PROVES, AND WHAT IT DOES NOT ──────────────────────────────────────
     *
     * There are two guards: the length check bounds the WORK (the base64 decode and the scan)
     * and the 19-digit shape bounds the VALUE (a `change_log` seq is a `bigserial`). **Neither
     * is isolable from out here, and removing BOTH still answers 410** — measured, not assumed:
     * this route already refuses a cursor far ahead of its own horizon, so the status is
     * over-determined.
     *
     * So this case proves the ROUTE refuses, which is worth having, and it does not prove either
     * bound. Said rather than left implied, because a green mutation is exactly the evidence a
     * guard has not been watched fail — and the length check's whole effect is that a fifty-
     * thousand-digit string is not decoded and scanned, which no assertion on a response can see.
     */
    const since = await H(req("GET", `/sync?since=${huge}`, { bearer: s.token }), deps);
    expect(since.status).toBe(410);   // this route's own answer for a cursor it will not read

    // The snapshot cursor is a base64 JSON object, so its hostile form is a valid one made huge.
    const fatJson = Buffer.from(
      JSON.stringify({ v: 1, s: "1", d: null, i: randomUUID(), n: 0, pad: "x".repeat(50_000) }),
      "utf8",
    ).toString("base64url");
    const snapshot = await H(req("GET", `/sync/snapshot?cursor=${fatJson}`, { bearer: s.token }), deps);
    expect(snapshot.status).toBe(410);
    expect(snapshot.status).toBeLessThan(500);
  });
});

/**
 * `POST /auth/login` — the ceiling whose own docstring names this route's attack.
 *
 * `PASSWORD_MAX_LENGTH` exists because *"`scrypt` is deliberately ~100 ms, it is run before the
 * transaction opens, and `register` is public: without a ceiling a caller can post a
 * multi-megabyte password and spend the host's CPU at will."* Every word is true of `login`,
 * which is equally public and reached far more often — and `login` called `requireField` alone.
 * The input-bounds census recorded the route as bounded by that constant, which is how the gap
 * was found: the disposition was written, and then checked.
 *
 * Watched fail and restored: delete the `[...password].length > PASSWORD_MAX_LENGTH` block in
 * `AuthService.login` and the first case answers 401 after paying for the hash.
 */
describe("an over-long password is refused before it reaches scrypt", () => {
  it("is a 400 naming the limit, on the anonymous login route", async () => {
    const { deps } = await makeDeps();

    const res = await H(req("POST", "/auth/login", {
      body: JSON.stringify({ email: "someone@example.com", password: "x".repeat(PASSWORD_MAX_LENGTH + 1) }),
    }), deps);

    const { code } = await expectRefusal(res, [400], PASSWORD_MAX_LENGTH);
    expect(code).toBe("validation_failed");
  });

  it("a SHORT password is still allowed to try — the minimum is not applied to a guess", async () => {
    const { deps } = await makeDeps();
    // A stored password shorter than today's policy must still be able to sign in; refusing one
    // here would lock out anybody who registered before the minimum was raised. So this is the
    // ordinary wrong-credentials answer, not a validation refusal.
    const res = await H(req("POST", "/auth/login", {
      body: JSON.stringify({ email: "someone@example.com", password: "short" }),
    }), deps);

    expect(res.status).toBe(401);
  });
});

/**
 * The two ceilings round 11 found had no behavioural test at all.
 *
 * A constant listed in the census and a `if (…) throw` in the source are not evidence — the
 * census asserts the number is finite and positive, and nothing drove the value. Deleting either
 * guard left every existing test green.
 */
describe("the two ceilings that were listed but never driven", () => {
  it("an over-long attachment filename or content type is a 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const created = await H(req("POST", "/drafts", {
      bearer: s.token, body: JSON.stringify({ mailboxId: mb, to: [{ address: "a@example.com" }] }),
    }), deps);
    const { id } = await created.json() as { id: string };

    // These become MIME header parameters on the outgoing message; only the COUNT and the total
    // BYTES were bounded, so a full list of entries with a megabyte filename each is a message whose
    // headers are enormous, built by this process.
    for (const field of ["filename", "contentType"] as const) {
      const res = await H(req("POST", `/drafts/${id}/send`, {
        bearer: s.token,
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({
          attachments: [{
            [field]: "x".repeat(SEND_ATTACHMENT_FIELD_MAX_CHARS + 1),
            contentBase64: Buffer.from("hi").toString("base64"),
          }],
        }),
      }), deps);
      const body = await res.json() as { error?: { code?: string; message?: string } };
      expect(res.status, `${field} → ${body.error?.code}`).toBe(400);
      expect(body.error?.message).toContain(String(SEND_ATTACHMENT_FIELD_MAX_CHARS));
    }
  });

  it("a delta cursor whose seq is past what a bigserial holds is refused — but see the note", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // Nineteen DIGITS, and larger than a signed bigint — so a digit-count grammar accepts it and
    // the value reaches a comparison it cannot survive.
    const cursor = Buffer.from("9999999999999999999", "utf8").toString("base64url");

    const res = await H(req("GET", `/sync?since=${cursor}`, { bearer: s.token }), deps);

    expect(res.status).toBe(410);
    expect(res.status).toBeLessThan(500);
    /**
     * NOT ISOLATING, and measured as such: removing the `seq > MAX_BIGSERIAL` check leaves this
     * green, because a seq that large is also ahead of the account's horizon and this route
     * already refuses that with the same 410. The guard is correct — the value cannot survive a
     * `bigint` comparison — and this case proves the ROUTE refuses rather than proving the guard.
     * Said here because a green mutation is exactly the evidence a guard has not been watched
     * fail, and the same is true of the `?since=` length bound one describe up.
     */
  });
});

/**
 * The two the TWELFTH review round found, and both are the same shape as the census's own
 * blind spots rather than new ideas.
 *
 * The first is a FAN-IN the request door cannot see: a ceiling that holds per request says
 * nothing about a value the request PERSISTS and a later request gathers. The census had written
 * the opposite down as this route's disposition, which is where the defect lived.
 *
 * The second is a ceiling applied to the RESULT of a read rather than to the read — this slice's
 * own shape, one layer up, on the only input that arrives from somebody's mailbox rather than
 * from an HTTP client.
 */
describe("the twelfth round", () => {
  it("a staged attachment's filename and content type carry the INLINE entrance's ceiling", async () => {
    const { db, deps: base } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // A minted ticket is what an ACCEPTED request produces, so the port must exist for the
    // control below to mean anything — without it every case is the deployment's 503 and the
    // ceiling is never reached, which is what the first run of this test measured.
    let minted = 0;
    const deps = {
      ...base,
      services: {
        ...base.services!,
        attachmentStaging: () => ({
          async mint() { minted += 1; return { id: randomUUID(), url: "https://s3.invalid/put", headers: {}, expiresAt: FIXED_NOW }; },
          source: { async declare() { return []; }, async fetch() { return []; } },
        }),
      },
    } as unknown as typeof base;

    for (const field of ["filename", "contentType"] as const) {
      const res = await H(req("POST", "/attachments/staging", {
        bearer: s.token,
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({
          mailboxId: mb, sizeBytes: 1,
          [field]: "x".repeat(SEND_ATTACHMENT_FIELD_MAX_CHARS + 1),
        }),
      }), deps);
      const body = await res.json() as { error?: { code?: string; message?: string } };
      expect(res.status, `${field} → ${body.error?.code} ${body.error?.message}`).toBe(400);
      expect(body.error?.message).toContain(String(SEND_ATTACHMENT_FIELD_MAX_CHARS));
    }

    // …and the ceiling refuses nothing real: a name AT it mints a ticket. Without this the test
    // would pass against a route that refused every mint, which is the failure mode four of this
    // slice's first-attempt ceilings actually had.
    const ok = await H(req("POST", "/attachments/staging", {
      bearer: s.token,
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({
        mailboxId: mb, sizeBytes: 1,
        filename: `${"x".repeat(SEND_ATTACHMENT_FIELD_MAX_CHARS - 4)}.bin`,
      }),
    }), deps);
    expect(ok.status).toBe(201);
    // The refusals never reached the port; the accepted one did. Both halves matter — a ceiling
    // that refuses everything and a ceiling that refuses nothing both pass a one-sided test.
    expect(minted).toBe(1);
  });

  it("a draft may hold what a send may carry — Reply All is not refused by the draft path", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const addrs = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({ address: `${tag}${i}@example.com` }));

    // The regression: Reply All copies a RECEIVED audience, and a message may legally arrive with
    // more addresses in `To:` than one field took while staying under the total this product will send. The
    // per-field ceiling of 100 refused a draft the product itself had just composed.
    const ok = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId: mb, to: addrs(150, "t"), cc: addrs(150, "c") }),
    }), deps);
    expect(ok.status, await ok.clone().text()).toBe(201);

    // …and the ceiling is a TOTAL, because three fields at 500 each is a body no door both admits
    // and is worth having — the census computes that product and this is the service side of it.
    const over = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({
        mailboxId: mb,
        to: addrs(DRAFT_MAX_RECIPIENTS, "t"),
        cc: addrs(1, "c"),
      }),
    }), deps);
    const body = await over.json() as { error?: { code?: string; message?: string } };
    expect(over.status, body.error?.message).toBe(413);
    expect(body.error?.message).toContain("across to, cc and bcc");
    expect(body.error?.message).toContain(String(DRAFT_MAX_RECIPIENTS));
  });

  it("a received subject is CLAMPED, and the clamp is what keeps a reply repliable", async () => {
    // A sender chooses this value and RFC 5322 puts no ceiling on it. The failure the ceiling
    // prevents is not the storage — it is that a reply inherits the subject with `Re: ` in front
    // and `DraftsService` REFUSES over DRAFT_SUBJECT_MAX_CHARS, so without a clamp at ingest a
    // sender could make one of their own messages permanently unrepliable.
    const hostile = "x".repeat(INGEST_SUBJECT_MAX_CHARS * 4);

    const kept = ingestSubject(hostile);

    expect(kept.length).toBe(INGEST_SUBJECT_MAX_CHARS);
    // The arithmetic that makes the two ceilings compatible, asserted rather than assumed: the
    // longest thing ingest can hand a reply, plus the prefix, still fits what drafts accept.
    expect(`Re: ${kept}`.length).toBeLessThanOrEqual(DRAFT_SUBJECT_MAX_CHARS);
    // …and an ordinary subject is untouched — a clamp that rewrote every subject would be a
    // silent data change, which is worse than the bound it is buying.
    expect(ingestSubject("Quarterly report")).toBe("Quarterly report");
    expect(ingestSubject(null)).toBe("");
  });

  it("a received display name is clamped to what the draft path will accept", async () => {
    // A plain Reply copies the parent's `from` — name included — into the draft recipient. Without
    // this clamp a sender picks a 101-character display name and their own message can no longer
    // be replied to through the ordinary UI, with a refusal naming a limit the user never typed.
    const kept = ingestDisplayName("n".repeat(INGEST_DISPLAY_NAME_MAX_CHARS * 3));
    expect(kept!.length).toBe(INGEST_DISPLAY_NAME_MAX_CHARS);
    // The two ceilings must agree, and `packages/core` cannot import `packages/services` to say
    // so — this is the assertion that keeps them from drifting apart.
    expect(INGEST_DISPLAY_NAME_MAX_CHARS).toBeLessThanOrEqual(RECIPIENT_NAME_MAX_CHARS);
    // ABSENT stays absent: a clamp that turned `null` into `""` would put an empty display name
    // on every address that never had one.
    expect(ingestDisplayName(null)).toBeNull();
    expect(ingestDisplayName("Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("a cursor date before PostgreSQL's floor is a 400, not a 500", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // Inside `Date`'s range (which is what the grammar used to check) and OUTSIDE `timestamptz`'s
    // — the two intervals overlap but are not the same, and the lower end is where they differ.
    const cursor = Buffer.from(`-8640000000000000:${randomUUID()}`, "utf8").toString("base64url");

    const res = await H(req("GET", `/messages?view=imbox&cursor=${cursor}`, { bearer: s.token }), deps);

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("cursor");
  });

  it("…and a snapshot cursor's date is held to the same floor", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const cursor = Buffer.from(JSON.stringify({
      v: 1, s: "0", d: -8_640_000_000_000_000, i: randomUUID(), n: 0,
    }), "utf8").toString("base64url");

    const res = await H(req("GET", `/sync/snapshot?cursor=${cursor}`, { bearer: s.token }), deps);

    expect(res.status).toBeLessThan(500);
    expect([400, 410]).toContain(res.status);
  });

  it("GET /auth/audit REFUSES a limit that is not a page, by name", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    // What these four values used to cost: `Math.min(Math.max(1, 1.5), 200)` is 1.5, and a
    // fraction reaches `bigint` as `invalid input syntax` — a 500 for a query string; `abc` is
    // NaN, which survives the arithmetic, and drizzle then omits the LIMIT clause entirely.
    // The clamp closed the 500 by answering the DEFAULT page, which is a silent reinterpretation
    // of a request nobody can have meant. `query-bounds.ts` now refuses the shape at the seam,
    // naming the field, and the assertion moved with the decision.
    for (const q of ["1.5", "abc", "-1e999", "1e999"]) {
      const res = await H(req("GET", `/auth/audit?limit=${q}`, { bearer: s.token }), deps);
      expect(res.status, `?limit=${q}`).toBe(400);
      const body = await res.json() as { error?: { message?: string } };
      expect(body.error?.message, `?limit=${q}`).toBe("limit must be a whole number of at least 1");
    }
    // …and a real page is still a page: the BAND is untouched and stays with the service.
    const ok = await H(req("GET", "/auth/audit?limit=5", { bearer: s.token }), deps);
    expect(ok.status).toBe(200);
  });

  it("a staged attachment id that is not a uuid is a 400, not a 22P02", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const created = await H(req("POST", "/drafts", {
      bearer: s.token, body: JSON.stringify({ mailboxId: mb, to: [{ address: "a@example.com" }] }),
    }), deps);
    const { id } = await created.json() as { id: string };

    const res = await H(req("POST", `/drafts/${id}/send`, {
      bearer: s.token,
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({ stagedAttachmentIds: ["x"] }),
    }), deps);

    const body = await res.json() as { error?: { code?: string; message?: string } };
    expect(res.status, body.error?.message).toBe(400);
    expect(body.error?.message).toContain("stagedAttachmentIds");
  });

  it("a profile message past the document ceiling is unreadable, not parsed", async () => {
    // The document is the message BODY and `parseProfileMessage` hands it to JSON.parse. This
    // builds a message whose body is over the ceiling WITHOUT building a valid document — the
    // point is that the ceiling is consulted on the raw bytes, so nothing here needs to parse.
    const oversized = [
      "X-Ohmail-Profile: 1",
      "Subject: ohmail settings for this mailbox",
      "",
      `{"v":1,"pad":"${"p".repeat(PROFILE_DOC_MAX_BYTES + 16)}"}`,
    ].join("\r\n");

    const read = await readOrganizerProfile({
      async listProfileMessages() { return [{ ref: { uid: 1 }, raw: oversized }]; },
    } as unknown as Parameters<typeof readOrganizerProfile>[0]);

    expect(read.state).toBe("unreadable");
    expect((read as { reason: string }).reason).toContain(String(PROFILE_DOC_MAX_BYTES));
  });

  it("…and the ceiling is measured in WIRE bytes, not UTF-16 units", async () => {
    // A three-byte character is ONE `.length` unit. A ceiling written as `.length` would admit a
    // document three times the size it thinks it is admitting — the same undercount the door's
    // own six-bytes-per-escaped-control arithmetic exists to avoid, in the other direction.
    const pad = "\u3042".repeat(Math.ceil((PROFILE_DOC_MAX_BYTES + 16) / 3));
    expect(pad.length).toBeLessThan(PROFILE_DOC_MAX_BYTES);
    expect(Buffer.byteLength(pad, "utf8")).toBeGreaterThan(PROFILE_DOC_MAX_BYTES);

    const read = await readOrganizerProfile({
      async listProfileMessages() {
        return [{ ref: { uid: 1 }, raw: `X-Ohmail-Profile: 1\r\n\r\n{"v":1,"p":"${pad}"}` }];
      },
    } as unknown as Parameters<typeof readOrganizerProfile>[0]);

    expect(read.state).toBe("unreadable");
  });

  it("a profile UNDER the ceiling still reads — the ceiling refuses nothing the product writes", async () => {
    const doc = {
      v: 1, updatedAt: FIXED_NOW.toISOString(), producer: { kind: "test", version: "1" },
      screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["work"],
    };
    const raw = [
      "X-Ohmail-Profile: 1", "X-Ohmail-Install-Id: i-1",
      "Subject: ohmail settings for this mailbox", "", JSON.stringify(doc),
    ].join("\r\n");

    const read = await readOrganizerProfile({
      async listProfileMessages() { return [{ ref: { uid: 1 }, raw }]; },
    } as unknown as Parameters<typeof readOrganizerProfile>[0]);

    expect(read.state).toBe("found");
  });
});
