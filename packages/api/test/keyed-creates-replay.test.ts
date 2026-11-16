import type { Db } from "@trafficflow/services";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  contactNotes, kbEntries, notifyRules, snippets, threadNotes, workflows,
} from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedContact, seedThread, req, FIXED_NOW } from "./helpers.js";

/**
 * six creates wrote a durable row with nothing unique about it, so a retry
 * after a lost response left two. Each claims its key INSIDE the insert transaction now. One file
 * for the six because it is one property; the ROW COUNT is the load-bearing assertion, since a
 * replay that answered correctly while writing a second row would pass the body comparison.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

interface Case {
  name: string;
  /** Build the request path and body; may seed whatever parent the row hangs off. */
  arrange(db: Db, accountId: string): Promise<{ path: string; body: unknown }>;
  /** How many rows this account now holds of the kind the create writes. */
  count(db: Db, accountId: string): Promise<number>;
}

const rows = async (q: Promise<unknown[]>): Promise<number> => (await q).length;

const CASES: Case[] = [
  {
    name: "POST /snippets",
    async arrange() { return { path: "/snippets", body: { title: "t", body: "b" } }; },
    count: (db, a) => rows(db.select().from(snippets).where(eq(snippets.accountId, a))),
  },
  {
    name: "POST /kb",
    async arrange() { return { path: "/kb", body: { title: "t", content: "c" } }; },
    count: (db, a) => rows(db.select().from(kbEntries).where(eq(kbEntries.accountId, a))),
  },
  {
    name: "POST /notify-rules",
    async arrange() { return { path: "/notify-rules", body: { target: "someone@example.com" } }; },
    count: (db, a) => rows(db.select().from(notifyRules).where(eq(notifyRules.accountId, a))),
  },
  {
    name: "POST /contacts/:id/notes",
    async arrange(db, accountId) {
      const contactId = await seedContact(db, { accountId });
      return { path: `/contacts/${contactId}/notes`, body: { body: "a note" } };
    },
    count: (db, a) => rows(db.select().from(contactNotes).where(eq(contactNotes.accountId, a))),
  },
  {
    name: "POST /threads/:id/notes",
    async arrange(db, accountId) {
      const threadId = await seedThread(db, { accountId });
      return { path: `/threads/${threadId}/notes`, body: { body: "a note" } };
    },
    count: (db, a) => rows(db.select().from(threadNotes).where(eq(threadNotes.accountId, a))),
  },
  {
    name: "POST /workflows",
    async arrange() {
      return { path: "/workflows", body: { name: "wf", trigger: { kind: "manual" } } };
    },
    count: (db, a) => rows(db.select().from(workflows).where(eq(workflows.accountId, a))),
  },
];

describe("a keyed create replays instead of minting a second row", () => {
  for (const c of CASES) {
    it(`${c.name} — the retry replays, and there is ONE row`, async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW });
      const { path, body } = await c.arrange(db, s.accountId);

      const press = (): Promise<Response> => H(req("POST", path, {
        bearer: s.token, headers: { "idempotency-key": "create-1" },
        body: JSON.stringify(body),
      }), deps);

      const first = await press();
      expect(first.status).toBe(201);
      const firstDto = await first.json();

      const retry = await press();
      expect(retry.status, "the retry did not replay the first answer's status").toBe(201);
      expect(await retry.json(), "the retry answered about a different row").toEqual(firstDto);

      expect(await c.count(db, s.accountId), "the retry minted a second row").toBe(1);
    });

    /** THE VACUITY GUARD: a DIFFERENT key really does make a second row. */
    it(`${c.name} — a different key is a second row`, async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW });
      const { path, body } = await c.arrange(db, s.accountId);

      for (const key of ["create-a", "create-b"]) {
        const res = await H(req("POST", path, {
          bearer: s.token, headers: { "idempotency-key": key }, body: JSON.stringify(body),
        }), deps);
        expect(res.status).toBe(201);
      }
      expect(await c.count(db, s.accountId)).toBe(2);
    });

    /** AND AN UNKEYED PRESS is unaffected — the key is honoured, never required. */
    it(`${c.name} — no key at all still creates`, async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW });
      const { path, body } = await c.arrange(db, s.accountId);
      const res = await H(req("POST", path, { bearer: s.token, body: JSON.stringify(body) }), deps);
      expect(res.status).toBe(201);
      expect(await c.count(db, s.accountId)).toBe(1);
    });
  }
});
