import { describe, expect, it } from "vitest";
import { drafts, outboundSends, scheduledSendFiles } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { SCHEDULED_FILES_PLAIN, type ScheduledFilesKeeping } from "@trafficflow/services/mail";
import { keepScheduledFilesSealed, runScheduledSendPass } from "@trafficflow/services";
import { StaticKeyProvider } from "@trafficflow/core";
import { FIXED_NOW, makeDeps, seedMailbox, seedSession } from "../../api/test/helpers.js";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  FixturesAdapter,
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  scheduledSendsList,
  type FetchLike,
} from "@ohmail/client-engine";

/**
 * SEND LATER, END TO END THROUGH THE REAL BACKEND (mail 0077) — the engine's `mail_send`
 * carrying `sendAt` against `createApp(apiRoutes)`: the SAME `DraftsService` +
 * `ScheduleService` + router the deployed API runs, over PGlite, with the SMTP seam a spy.
 *
 * THE ASSERTION THAT MATTERS is the inverse of `mail-send.test.ts`'s: a Send-later press must
 * deliver NOTHING — no dial, no reservation, no Sent overlay — and leave exactly one
 * appointment the worker's pass (its own suite) will keep. The delivery half of the feature is
 * `send-later.test.ts` in `packages/services`; this file owns the wire and the mirror.
 */

const app = createApp(apiRoutes);
/* The desktop engine's own table: the one that keeps a scheduled letter's files (mail 0179). */
const localApp = createApp(localRoutes);

function makeSendSpy() {
  const spy = {
    delivered: [] as OutboundMessage[],
    factory: (async () => ({
      async send(msg: OutboundMessage) {
        spy.delivered.push(msg);
        return { providerMessageId: msg.messageId ?? "<none>" };
      },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    })) as OpenSendAdapter,
  };
  return spy;
}

function bridgeFetch(deps: ApiDeps, token: string, on = app): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${token}`);
    return on.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null });
  };
}

const SEND_AT = new Date(FIXED_NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();

async function world(o: {
  local?: boolean; scheduleFilesCheck?: boolean; scheduleFiles?: boolean; sealed?: ScheduledFilesKeeping;
} = {}) {
  const spy = makeSendSpy();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: spy.factory });
  // The desktop engine declares where it keeps a letter's files; a bag that declares nothing keeps none.
  if (o.local) deps.services = { ...deps.services!, scheduledFiles: SCHEDULED_FILES_PLAIN };
  if (o.sealed) deps.services = { ...deps.services!, scheduledFiles: o.sealed };
  if (o.scheduleFiles !== undefined) {
    deps.hello = {
      flavor: o.local ? "local" : "managed", needsSetup: false,
      auth: { password: false, totp: false, webauthn: false, publicSignup: false },
      features: { sse: false, staging: false, ai: false, pairing: false, remoteImages: true, scheduleFiles: o.scheduleFiles },
    };
  }
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });

  const calls: string[] = [];
  const base = bridgeFetch(deps, s.token, o.local ? localApp : app);
  type Intercept = (url: string, pass: () => Promise<Response>) => Promise<Response> | null;
  let intercept: Intercept | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    const pass = (): Promise<Response> => base(url, init);
    return intercept?.(url, pass) ?? pass();
  };
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, ...(o.scheduleFilesCheck ? { scheduleFilesCheck: true } : {}),
    }),
    store: new MemoryMirrorStore(),
  });
  return {
    db, spy, engine, calls, mailboxId,
    setIntercept: (fn: Intercept | null) => { intercept = fn; },
  };
}

const COMPOSE = (mailboxId: string) => ({
  kind: "mail_send" as const,
  inReplyTo: null,
  mailboxId,
  subject: "later",
  body: "the words",
  to: [{ name: null, address: "you@example.com" }],
  sendAt: SEND_AT,
});

describe("mail_send with sendAt — an appointment, not a delivery", () => {
  it("confirms over POST /drafts + POST /drafts/:id/schedule, dials nothing, reserves nothing", async () => {
    const w = await world();
    const res = await w.engine.mutate(COMPOSE(w.mailboxId));
    expect(res.status).toBe("confirmed");
    // NOTHING LEFT: the spy never dialed and there is no Sent overlay to materialise from —
    // the outcome carried no providerMessageId, which is the engine's gate.
    expect(w.spy.delivered).toHaveLength(0);
    expect(res).not.toHaveProperty("providerMessageId", expect.stringContaining("@"));

    const rows = await w.db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("scheduled");
    expect(rows[0]!.sendAt!.toISOString()).toBe(SEND_AT);
    expect(rows[0]!.sendKey).not.toBeNull();
    expect(await w.db.select().from(outboundSends)).toHaveLength(0);

    // The wire shape: draft, then schedule — and NEVER /send.
    const posts = w.calls.filter((c) => c.startsWith("POST"));
    expect(posts).toEqual(["POST /drafts", `POST /drafts/${rows[0]!.id}/schedule`]);
    expect(w.calls.some((c) => c.endsWith("/send"))).toBe(false);

    // THE ECHO IS READ-YOUR-WRITES: the route answers the scheduled DTO with its seq, the
    // adapter hands it back as a draft change, and the mirror holds the appointment the moment
    // the mutation confirms — WITHOUT waiting for any drain. The confirm drops the optimistic
    // overlay, so an empty echo here would leave the Scheduled group blank until a background
    // sync landed (or did not — a hidden tab aborts it). Asserted with NO `syncOnce` on
    // purpose: that call passing was exactly the hole.
    const listed = scheduledSendsList(w.engine.read());
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(rows[0]!.id);
    expect(listed[0]!.sendAt).toBe(SEND_AT);
  });

  it("draft_schedule_cancel takes the appointment off over DELETE /drafts/:id/schedule", async () => {
    const w = await world();
    await w.engine.mutate(COMPOSE(w.mailboxId));
    const [row] = await w.db.select().from(drafts);

    await w.engine.syncOnce();
    const res = await w.engine.mutate({ kind: "draft_schedule_cancel", draftId: row!.id });
    expect(res.status).toBe("confirmed");
    expect(w.calls).toContain(`DELETE /drafts/${row!.id}/schedule`);

    const [after] = await w.db.select().from(drafts);
    expect(after!.status).toBe("draft");
    expect(after!.sendAt).toBeNull();
    expect(after!.sendKey).toBeNull();
    await w.engine.syncOnce();
    expect(scheduledSendsList(w.engine.read())).toHaveLength(0);
  });

  it("a past time is the server's 400, surfaced as a rejection — nothing scheduled, nothing sent", async () => {
    const w = await world();
    const res = await w.engine.mutate({
      ...COMPOSE(w.mailboxId),
      sendAt: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
    });
    expect(res.status).toBe("rolled_back");
    const [row] = await w.db.select().from(drafts);
    expect(row!.status).toBe("draft"); // the draft row stands; the appointment was refused
    expect(row!.sendAt).toBeNull();
    expect(w.spy.delivered).toHaveLength(0);
  });

  it("REFUSES attachments and forwards before the wire — a draft row cannot carry either", async () => {
    const w = await world();
    const res = await w.engine.mutate({
      ...COMPOSE(w.mailboxId),
      attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "aGk=" }],
    });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("schedule_unsupported_content");
    // Refused CLIENT-side, before the schedule request exists.
    expect(w.calls.some((c) => c.includes("/schedule"))).toBe(false);
    expect(w.spy.delivered).toHaveLength(0);
  });

  it("VERSION SKEW: a server without the route answers 404 and the press must NOT fall back to sending now", async () => {
    const w = await world();
    w.setIntercept((url) => {
      if (new URL(url).pathname.endsWith("/schedule")) {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }));
      }
      return null;
    });
    const res = await w.engine.mutate(COMPOSE(w.mailboxId));
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("schedule_unsupported");
    expect(res.error?.retryable).toBe(false);
    // The one catastrophic fallback — delivering NOW what was asked for LATER — did not happen.
    expect(w.spy.delivered).toHaveLength(0);
    expect(w.calls.some((c) => c.endsWith("/send"))).toBe(false);
  });
});

describe("mail_send with sendAt and files — where the door keeps them (mail 0179)", () => {
  const FILES = [
    { filename: "photo.png", contentType: "image/png", contentBase64: Buffer.from("a picture").toString("base64") },
    { filename: "invoice.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 a page").toString("base64") },
  ];

  it("schedules over POST /drafts/:id/schedule-with-files with the files, and the store keeps them", async () => {
    const w = await world({ local: true, scheduleFilesCheck: true });
    const res = await w.engine.mutate({ ...COMPOSE(w.mailboxId), attachments: FILES });
    expect(res.status).toBe("confirmed");
    const [row] = await w.db.select().from(drafts);
    expect(row).toMatchObject({ status: "scheduled", sendFiles: 2 });
    expect(w.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /drafts", `POST /drafts/${row!.id}/schedule-with-files`]);
    const kept = await w.db.select().from(scheduledSendFiles);
    expect(kept.map((f) => [f.fileNo, f.filename, f.contentType, f.rawB64])).toEqual(
      FILES.map((f, i) => [i, f.filename, f.contentType, f.contentBase64]),
    );
    expect(w.spy.delivered).toHaveLength(0);
    expect(scheduledSendsList(w.engine.read())[0]).toMatchObject({ id: row!.id, sendFiles: 2 });
  });

  it("a door without the route (Cloud) answers 404: refused by name, nothing scheduled, nothing sent", async () => {
    const w = await world({ scheduleFilesCheck: true });
    const res = await w.engine.mutate({ ...COMPOSE(w.mailboxId), attachments: FILES });
    expect(res.status).toBe("rolled_back");
    expect(res.error).toMatchObject({ code: "schedule_files_unsupported", retryable: false });
    const [row] = await w.db.select().from(drafts);
    expect(row).toMatchObject({ status: "draft", sendAt: null });
    expect(w.spy.delivered).toHaveLength(0);
    expect(w.calls.some((c) => c.endsWith("/send"))).toBe(false);
  });

  it("/hello says which door keeps files: the desktop engine yes, Cloud no; with the check off nothing is asked", async () => {
    const local = await world({ local: true, scheduleFilesCheck: true, scheduleFiles: true });
    const cloud = await world({ scheduleFilesCheck: true, scheduleFiles: false });
    const off = await world({ local: true, scheduleFiles: true });
    expect(await local.engine.scheduleFilesAnnounced()).toBe(true);
    expect(await cloud.engine.scheduleFilesAnnounced()).toBe(false);
    expect(await off.engine.scheduleFilesAnnounced()).toBe(null);
    expect(off.calls).toEqual([]);
  });
});

describe("the demo world (FixturesAdapter)", () => {
  it("a Send-later press parks a scheduled draft and mints NO provider id — nothing 'sends' even in fiction", async () => {
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      store: new MemoryMirrorStore(),
    });
    await engine.syncOnce();
    const res = await engine.mutate({
      kind: "mail_send", inReplyTo: null, mailboxId: "mb-demo",
      subject: "later", body: "demo words",
      to: [{ name: null, address: "you@example.com" }],
      sendAt: SEND_AT,
    });
    expect(res.status).toBe("confirmed");
    const listed = scheduledSendsList(engine.read());
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("scheduled");
    expect(listed[0]!.sendAt).toBe(SEND_AT);
  });
});

/**
 * SEND LATER WITH FILES ON THE HOSTED DOOR (mail 0180), engine to delivery: the same client presses
 * schedule on the hosted table, the server keeps the file sealed, and its pass sends it once.
 */
describe("the hosted door keeps a scheduled letter's files sealed until its pass sends them", () => {
  it("the engine's press is kept as ciphertext and leaves once, byte-equal, with no row left", async () => {
    const sealed = keepScheduledFilesSealed(new StaticKeyProvider({ 1: Buffer.alloc(32, 9) }));
    if (sealed.atRest !== "sealed") throw new Error("a server keeps its files sealed");
    const w = await world({ scheduleFilesCheck: true, scheduleFiles: false, sealed });
    const file = { filename: "plan.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 the plan").toString("base64") };
    const res = await w.engine.mutate({ ...COMPOSE(w.mailboxId), attachments: [file] });
    expect(res.status).toBe("confirmed");
    const kept = await w.db.select().from(scheduledSendFiles);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.dekKeyVersion).toBe(1);
    expect(kept[0]!.rawB64).not.toBe(file.contentBase64);
    expect(w.spy.delivered, "a press scheduled to the hosted door dialled at once").toHaveLength(0);

    await runScheduledSendPass(w.db as never, {
      openSendAdapter: w.spy.factory, now: () => new Date(Date.parse(SEND_AT) + 60_000),
      files: { open: sealed.sealer.open.bind(sealed.sealer), tidy: true },
    });
    expect(w.spy.delivered).toHaveLength(1);
    expect(w.spy.delivered[0]!.attachments!.map((a) => Buffer.from(a.content).toString("base64"))).toEqual([file.contentBase64]);
    expect(await w.db.select().from(scheduledSendFiles)).toHaveLength(0);
  });
});
