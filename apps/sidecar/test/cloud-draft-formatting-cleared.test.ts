import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";

import { WindowOutboxStore } from "../../desktop/src/window-outbox-store.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE DESKTOP PAIRED TO CLOUD SAVES A DRAFT WHOSE FORMATTING WAS REMOVED AS PLAIN.
 *
 * The window said the cleared body as `body` alone and Cloud refused it (400 `validation_failed`,
 * logged `cloud_write_refused`): a body-only edit of a formatted row. The window now says
 * `html: null` for a row its mirror holds as formatted, and the sidecar carries it to Cloud as is.
 * The real window engine and its store over the real cloud engine; Cloud answers as
 * `DraftsService.update` does.
 */
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const MBX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TO = [{ name: null, address: "ada@fake.test" }];

function cloud(html: string | null, extra: Record<string, unknown> = {}) {
  const row = {
    id: DRAFT, mailboxId: MBX, threadId: null, inReplyToMessageId: null, forwardOfMessageId: null,
    subject: "Invoice 12", body: "bold", html, to: TO, cc: [], bcc: [], rationale: null, status: "draft",
    createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T09:00:00.000Z", ...extra,
  };
  const puts: Array<{ body: Record<string, unknown>; answered: number }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === `/drafts/${DRAFT}` && method === "PUT") {
      const body = JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>;
      const put = { body, answered: 200 };
      puts.push(put);
      // `DraftsService.update`: a plain edit of a formatted row must say `html: null`.
      if (typeof body.html !== "string" && body.html !== null && row.html !== null) {
        put.answered = 400;
        return json({ error: { code: "validation_failed", message: "this draft holds formatted text; send html, or send html: null to make it plain" } }, 400);
      }
      if (body.html === null) row.html = null;
      if (typeof body.body === "string") row.body = body.body;
      return json({ ...row, contentRevision: `r${puts.length}`, updatedAt: new Date().toISOString() });
    }
    if (url.pathname === "/auth/refresh") {
      return json({ tokens: { accessToken: "minted-access", refreshToken: "minted-refresh", expiresIn: 900 } });
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(MBX, "me@ohmail.test")]));
    if (url.pathname === "/sync") {
      const since = url.searchParams.get("since");
      const creates = since === null || since === "" || since === "0"
        ? [{ type: "draft", op: "create", id: DRAFT, seq: 1, updatedAt: row.updatedAt, entity: { ...row } }]
        : [];
      return json({ changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() });
    }
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return json({ error: { code: "not_found", message: "not found" } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, puts, row };
}

async function windowOverCloud(html: string | null, extra: Record<string, unknown> = {}) {
  const dataDir = await freshDataDir("ohmail-draft-plain-"); dirs.push(dataDir);
  const c = cloud(html, extra);
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://host.test", address: "me@ohmail.test", fetchImpl: c.fetchImpl,
    pollIntervalMs: 3_600_000, keks: { 1: Buffer.alloc(32, 7) }, tokens: { accessToken: "held-access", refreshToken: "held-refresh" },
  });
  sidecars.push(sidecar);
  await sidecar.start();
  const bridge = async (path: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as RequestInit;
    const headers = new Headers(i.headers);
    headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
    return sidecar.handle(new Request(`http://sidecar${path}`, { ...i, headers }));
  };
  const w = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "", fetch: bridge as never }),
    store: new WindowOutboxStore({ scope: sidecar.servedMailboxId(), write: bridge, read: bridge }),
  });
  await w.start();
  // The sidecar's mirror drains Cloud on its own clock; the window reads that mirror.
  const end = Date.now() + 20_000;
  while (w.read().get("draft", DRAFT) === undefined && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    await w.syncOnce().catch(() => undefined);
  }
  return { w, ...c };
}

const save = (html: string | null) => ({
  kind: "draft_save" as const, draftId: DRAFT, mailboxId: MBX, subject: "Invoice 12", body: "plain now", html,
  to: TO, cc: [], bcc: [],
});

describe("the desktop paired to Cloud, a draft whose formatting was removed", () => {
  it("the save reaches Cloud as the body with html: null, and the row becomes plain", { timeout: 60_000 }, async () => {
    const t = await windowOverCloud("<p><strong>bold</strong></p>");
    expect((t.w.read().get<{ html?: string | null }>("draft", DRAFT))?.html, "control: the window holds the row as formatted")
      .toBe("<p><strong>bold</strong></p>");
    const r = await t.w.mutate(save(null));
    expect(r.status, r.error?.message).toBe("confirmed");
    expect(t.puts.map((p) => p.body)).toEqual([expect.objectContaining({ body: "plain now", html: null })]);
    expect(t.row.html).toBeNull();
  });

  it("control: a plain row's save carries no html key", { timeout: 60_000 }, async () => {
    const t = await windowOverCloud(null);
    expect((await t.w.mutate(save(null))).status).toBe("confirmed");
    expect(t.puts).toHaveLength(1);
    expect("html" in t.puts[0]!.body).toBe(false);
  });
});

describe("the desktop paired to Cloud, a scheduled draft", () => {
  it("keeps the time it sends at, as the web's row does", { timeout: 60_000 }, async () => {
    const t = await windowOverCloud(null, { status: "scheduled", sendAt: "2026-10-25T17:00:00.000Z" });
    const row = t.w.read().get<{ status?: string; sendAt?: string | null }>("draft", DRAFT);
    expect(row?.status).toBe("scheduled");
    expect(row?.sendAt).toBe("2026-10-25T17:00:00.000Z");
  });
});
