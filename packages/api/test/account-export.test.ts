import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { accountSettings, contacts, rules, tags, mailboxes, awayResponders } from "@trafficflow/db";
import type { AccessVerdict, EntitlementsPort } from "@trafficflow/db";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as mailSchema from "@trafficflow/db/mail";
import { CALENDAR_EXPORT } from "@trafficflow/services/calendar";

/**
 * `GET /account/export` — the way out with your configuration (the wall).
 *
 * Three properties, each its own failure class: the document is EXACTLY what the worker
 * publishes into `ohmail/_meta` for the same mailbox (one serializer, so a self-hosted install
 * joining the mailbox reads the identical configuration); NO key of the document matches a
 * credential shape (an export that leaked a password would follow the person out the door);
 * and the door is OPEN UNDER THE WALL (leave-anytime is not suspended by a lapsed subscription).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const refusing: EntitlementsPort = {
  access: async (): Promise<AccessVerdict> => ({ ok: false, reason: "payment_required" }),
  accessOrFault: async (): Promise<AccessVerdict> => ({ ok: false, reason: "payment_required" }),
  spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
  release: async () => "settled",
  manageLink: async () => null,
  releaseAccount: async () => "none",
};

async function seeded() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "export@wall.test",
    signature: "— me", status: "connected",
  }).returning();
  await db.insert(contacts).values({ accountId: s.accountId, address: "friend@example.com" });
  await db.insert(rules).values({
    accountId: s.accountId, kind: "domain", match: "feed.example", destination: "ohmail/Reads", priority: 3,
  });
  await db.insert(tags).values({ accountId: s.accountId, name: "travel" });
  await db.insert(awayResponders).values({
    accountId: s.accountId, enabled: true, body: "Back soon.", audience: "screened_in",
    throttle: "per_day", piles: ["INBOX"], enabledAt: FIXED_NOW,
  });
  return { db, deps, s, mailboxId: mb!.id };
}

/** Every key of a JSON document, dotted, so the refusal names the exact path. */
function keysOf(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysOf(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)]);
  }
  return [];
}

describe("GET /account/export", () => {
  it("is on apiRoutes and NOT on the local door — a local install's data is already local", () => {
    const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
    expect(apiRoutes.map(key)).toContain("GET /account/export");
    expect(localRoutes.map(key)).not.toContain("GET /account/export");
  });

  it("the per-mailbox document IS the worker's own — one serializer, byte for byte", async () => {
    const { db, deps, s, mailboxId } = await seeded();
    const res = await H(req("GET", "/account/export", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.mailboxes).toHaveLength(1);
    const published = await serializeOrganizerProfile(db, s.accountId, mailboxId);
    expect(JSON.stringify(body.mailboxes[0].profile)).toBe(JSON.stringify(published));
    // The seeds are IN it — an equality against an accidentally-empty document proves nothing.
    expect(JSON.stringify(published)).toContain("friend@example.com");
    expect(JSON.stringify(published)).toContain("feed.example");
    expect(body.settings.screeningScope).toBeDefined();
    // Under every bound nothing is left out, and the export says so beside the document.
    expect(body.mailboxes[0].leftOut).toEqual({ screener: 0, rules: 0, notifyRules: 0, tagNames: 0 });
  });

  it("carries the impersonation filing as a choice: on by default, off once turned off", async () => {
    const { db, deps, s } = await seeded();
    const read = async () => (await (await H(req("GET", "/account/export", { bearer: s.token }), deps)).json()).settings;
    expect((await read()).impersonationFiling).toBe(true);
    await db.insert(accountSettings).values({ accountId: s.accountId, impersonationFilingOffAt: FIXED_NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { impersonationFilingOffAt: FIXED_NOW } });
    expect((await read()).impersonationFiling).toBe(false);
  });

  it("NO key of the document matches a credential shape", async () => {
    const { deps, s } = await seeded();
    const body = await (await H(req("GET", "/account/export", { bearer: s.token }), deps)).json();
    const credentialShaped = keysOf(body).filter((k) => /password|token|secret|refresh|oauth/i.test(k));
    expect(credentialShaped, "an export must not carry a credential-shaped field").toEqual([]);
    // The positive control on the scanner itself: a planted key IS found.
    expect(keysOf({ a: [{ imapPassword: "x" }] }).some((k) => /password/i.test(k))).toBe(true);
  });

  it("is OPEN UNDER THE WALL — a refused account exports, and its product doors still 402", async () => {
    const { db, deps: base } = await makeDeps();
    const deps = {
      ...base,
      services: { ...base.services, entitlementsPort: refusing },
    } as ApiDeps;
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/account/export", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).v).toBe(1);
    // The control that keeps this from passing for a gate that opened everything.
    expect((await H(req("GET", "/mailboxes", { bearer: s.token }), deps)).status).toBe(402);
  });
});

/**
 * THE CALENDAR'S PART, BY CANARY. Every text and jsonb column of every calendar table, read from
 * the schema, holds a canary naming itself; the document must carry exactly the canaries of the
 * columns the export's map carries, and no other. A column the map never named, a table it never
 * answered, or a token, a sign-in or an original text in the document is red here, by name.
 */
describe("GET /account/export carries the calendar's configuration, and nothing else of it", () => {
  /** Columns a CHECK holds to a word, a kind or a moment beside another column: no canary fits. */
  const NO_CANARY: Record<string, string> = {
    "cal_connections.provider": "one lower-case word by CHECK", "cal_connections.status": "one lower-case word by CHECK",
    "cal_connections.error_code": "one lower-case word by CHECK",
    "cal_events.start_kind": "a kind of time by CHECK", "cal_events.end_kind": "a kind of time by CHECK",
    "cal_events.start_zone": "only beside a zoned start", "cal_events.end_zone": "only beside a zoned end",
    "cal_events.end_local": "only beside an end's kind", "cal_events.recurrence_id": "only beside the moment it names",
  };
  const canary = (key: string) => `CANARY_${key.replace(".", "_")}`;

  it("holds the map total over the schema, and the document to the map", async () => {
    const { db, deps, s, mailboxId } = await seeded();
    const client = (db as unknown as { $client: { query(t: string, p?: unknown[]): Promise<unknown> } }).$client;
    const plant = (t: string, p: unknown[]) => client.query(t, p);
    const c = (key: string) => canary(key);
    const j = (key: string) => JSON.stringify({ canary: canary(key) });
    const [conn, ics, cal, ev] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const a = s.accountId;
    const list = (table: string, cols: string[]) => cols.map((col) => c(`${table}.${col}`));
    const marks = (from: number, n: number) => Array.from({ length: n }, (_, i) => `$${from + i}`).join(", ");
    await plant("insert into cal_settings (account_id, enabled_at, second_zone, new_events_calendar_id) values ($1, now(), $2, $3)",
      [a, c("cal_settings.second_zone"), cal]);
    await plant(`insert into cal_connections (id, account_id, provider, status, error_code, label, server_url, principal, list_token, mailbox_id)
      values ($1, $2, 'caldav', 'active', 'unknown', ${marks(3, 4)}, $7)`,
      [conn, a, ...list("cal_connections", ["label", "server_url", "principal", "list_token"]), mailboxId]);
    await plant("insert into cal_connections (id, account_id, provider, label, source_host) values ($1, $2, 'ics', 'Holidays', $3)",
      [ics, a, c("cal_connections.source_host")]);
    await plant("insert into cal_credentials (account_id, connection_id, kind, secret_enc, key_version, meta) values ($1, $2, $3, $4, 1, $5::jsonb)",
      [a, conn, c("cal_credentials.kind"), c("cal_credentials.secret_enc"), j("cal_credentials.meta")]);
    const calCols = ["provider_id", "name", "color", "access", "time_zone", "sync_token", "fetch_etag", "error_code"];
    await plant(`insert into cal_calendars (id, account_id, connection_id, ${calCols.join(", ")}) values ($1, $2, $3, ${marks(4, calCols.length)})`,
      [cal, a, conn, ...list("cal_calendars", calCols)]);
    await plant("insert into cal_alarms (account_id, calendar_id, minutes_before, method) values ($1, $2, 15, $3)", [a, cal, c("cal_alarms.method")]);
    const evCols = ["provider_id", "version_tag", "uid", "status", "title", "notes", "place", "call_link", "start_local", "duration",
      "repeat_rule", "organizer", "organizer_name", "my_answer", "original"];
    await plant(`insert into cal_events (id, account_id, calendar_id, start_kind, starts_at, excluded_dates, added_dates, ${evCols.join(", ")})
      values ($1, $2, $3, 'floating', now(), $4::jsonb, $5::jsonb, ${marks(6, evCols.length)})`,
      [ev, a, cal, j("cal_events.excluded_dates"), j("cal_events.added_dates"), ...list("cal_events", evCols)]);
    await plant(`insert into cal_attendees (account_id, event_id, address, name, role, answer) values ($1, $2, ${marks(3, 4)})`,
      [a, ev, ...list("cal_attendees", ["address", "name", "role", "answer"])]);
    await plant(`insert into cal_writes (account_id, calendar_id, op, payload, base_version_tag, idempotency_key, state, refusal)
      values ($1, $2, $3, $4::jsonb, ${marks(5, 4)})`,
      [a, cal, c("cal_writes.op"), j("cal_writes.payload"), ...list("cal_writes", ["base_version_tag", "idempotency_key", "state", "refusal"])]);
    await plant(`insert into cal_links (account_id, message_id, mailbox_id, uid, recurrence_id, kind) values ($1, $2, $3, ${marks(4, 3)})`,
      [a, randomUUID(), mailboxId, ...list("cal_links", ["uid", "recurrence_id", "kind"])]);
    await plant("insert into cal_suggestions (account_id, message_id, mailbox_id, evidence, proposed, source_words, state) values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
      [a, randomUUID(), mailboxId, c("cal_suggestions.evidence"), j("cal_suggestions.proposed"), c("cal_suggestions.source_words"), c("cal_suggestions.state")]);

    const declared = Object.values(mailSchema as Record<string, unknown>).filter((t): t is PgTable => is(t, PgTable)).map((t) => getTableConfig(t))
      .filter((t) => t.name.startsWith("cal_"));
    expect(declared.map((t) => t.name).sort(), "a calendar table the export's map does not answer").toEqual(Object.keys(CALENDAR_EXPORT).sort());
    const textColumns = declared.flatMap((t) => t.columns
      .filter((col) => col.columnType === "PgText" || col.columnType === "PgJsonb").map((col) => `${t.name}.${col.name}`));
    const res = await H(req("GET", "/account/export", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect((JSON.parse(text) as { calendar?: unknown }).calendar).toBeDefined();
    // Which calendar new events go to is said once, from the settings: a calendar carries no second word for it.
    const carriedCalendars = (JSON.parse(text) as { calendar: { connections: { calendars: Record<string, unknown>[] }[] } }).calendar.connections
      .flatMap((k) => k.calendars);
    expect(carriedCalendars.map((k) => [Object.keys(k).sort(), k.newEvents])).toEqual([
      [["access", "color", "defaultAlerts", "name", "newEvents", "shown", "timeZone"], true],
    ]);
    const found = textColumns.filter((k) => text.includes(canary(k)));
    const carried = textColumns.filter((k) => {
      const answer = CALENDAR_EXPORT[k.split(".")[0] as keyof typeof CALENDAR_EXPORT];
      return "carries" in answer && answer.carries.includes(k.split(".")[1]!) && !(k in NO_CANARY);
    });
    expect(found.sort(), "the canaries in the document are not exactly the map's carried columns").toEqual(carried.sort());
    // Not vacuous: the canaries were read where they were planted, and the document carries some.
    const stored = JSON.stringify(await client.query("select * from cal_events, cal_writes, cal_credentials"));
    for (const k of ["cal_events.original", "cal_writes.payload", "cal_credentials.secret_enc"]) expect(stored).toContain(canary(k));
    expect(found.length).toBeGreaterThanOrEqual(8);
  });

  it("is absent for an account without a calendar: the document is as it was", async () => {
    const { deps, s } = await seeded();
    const doc = await (await H(req("GET", "/account/export", { bearer: s.token }), deps)).json() as Record<string, unknown>;
    expect(doc.calendar).toBeUndefined();
    expect(doc.v).toBe(1);
  });
});
