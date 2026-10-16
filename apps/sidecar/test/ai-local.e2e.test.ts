import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";
import { messages, routingDecisions } from "@trafficflow/db";
import { SCREEN_DESTINATIONS, SCREENING_PREFIX, TAXONOMY_PREFIX } from "@trafficflow/core/mail";
import { eq } from "drizzle-orm";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { AI_STORE_FILE } from "../src/ai-provider.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { draftReplyVia } from "../../desktop/src/draft-reply-wire.js";

/**
 * A STANDALONE INSTALL GETS AI OF ITS OWN — the acceptance, through the real assembly.
 *
 * Everything here goes over the bridge the interface will use, against the engine `main.ts`
 * builds, on a real mailbox on a real IMAP server. Nothing is constructed privately for the
 * test: the routes come from the app the engine mounted, the settings land in the file the
 * engine reads, and the routing suggestion is the one the sync loop asked for.
 *
 * The MODEL is the one thing injected, and it has to be: a test that reached a real endpoint
 * would spend somebody's money on every run, need a credential in CI, and fail for reasons that
 * have nothing to do with this code. It is injected AT THE TRANSPORT, so what is asserted is
 * the request that would have left this machine — its address, its method, its headers — rather
 * than which function was called.
 *
 * ── WHAT EACH CASE IS FOR ─────────────────────────────────────────────────────────────────
 *
 *  · An install with no model offers no drafts and makes no outbound request. Both halves: a
 *    503 the route table already knows how to say, and a call count of zero.
 *  · Configuring one is one round trip that also VERIFIES, so a mistake is found while somebody
 *    is still looking at the settings rather than the next time they try to answer an email.
 *  · The stored key is on disk sealed, and is never in a response.
 *  · A model that stops answering does not stop the mail: the next cycle files on rules and the
 *    sync cursor advances. That is the failure this whole arrangement exists to prevent, and it
 *    is asserted against a real cursor rather than a comment.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const KEY = anthropicKey("ai-local");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

function eml(o: { from: string; to: string; subject: string; messageId: string; body: string }): string {
  return [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
  ].join("\r\n");
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

/** The injected model. Records every request; `answer` decides what comes back. */
function model(): {
  calls: Call[];
  /** Flip to make every completion fail, as a revoked key or a stopped server would. */
  broken: { value: boolean };
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const broken = { value: false };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const json = (b: unknown): Response =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

    if (/\/v1\/models\?/.test(url)) return json({ data: [{ id: "claude-haiku-4-5-20251001" }] });
    if (/\/v1\/models\//.test(url)) return json({ id: "ok" });
    if (/\/v1\/messages$/.test(url)) {
      if (broken.value) return new Response("upstream is unwell", { status: 500 });
      const body = String(init?.body ?? "");
      // One endpoint answers both features, so which one is being asked is read off the request.
      const isDraft = body.includes("kbEntries");
      return json({
        content: [{
          type: "text",
          text: isDraft
            ? JSON.stringify({ subject: "Re: hello", body: "Thanks for writing.", rationale: "grounded in the thread" })
            : JSON.stringify({ destination: "ohmail/News", confidence: 0.92, rationale: "a newsletter", spam: false }),
        }],
      });
    }
    if (url === "https://opencode.ai/console/api/v2/config") {
      return json({ providers: { "opencode-go": { models: { "kimi-k3": {}, "glm-5.3-flash": {} } } } });
    }
    if (url === "https://opencode.ai/inference/go/v1/chat/completions") {
      if (broken.value) return new Response("upstream is unwell", { status: 500 });
      const isDraft = String(init?.body ?? "").includes("kbEntries");
      const answer = isDraft
        ? { subject: "Re: hello", body: "Thursday works.", rationale: "grounded in the thread" }
        : { destination: "ohmail/News", confidence: 0.92, rationale: "a newsletter", spam: false };
      return json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }] });
    }
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, broken, fetchImpl };
}

interface Launch { sidecar: Sidecar; host: StdioHost; client: StdioClient }

const open: Launch[] = [];
const dirs: string[] = [];
const raws: ImapFlow[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const c of raws.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-ai-e2e-"));
  dirs.push(d);
  return d;
}

async function launch(
  cfg: ReturnType<typeof greenmail>,
  dataDir: string,
  fetchImpl: typeof fetch,
): Promise<Launch> {
  const sidecar = await createSidecar({
    dataDir,
    imap: cfg,
    address: cfg.auth.user,
    displayName: "This Mac",
    keks: { 1: aKek() },
    fetchImpl,
    // Long enough that no poll fires on its own: every cycle here is one a case asked for.
    pollIntervalMs: 60 * 60 * 1000,
  });
  await grantOrganizeConsent(sidecar);
  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  const l: Launch = { sidecar, host, client };
  open.push(l);
  return l;
}

const auth = (l: Launch): Record<string, string> => ({
  authorization: `Bearer ${l.sidecar.sessionToken}`,
  "content-type": "application/json",
});

async function deliver(cfg: ReturnType<typeof greenmail>, subject: string, body: string): Promise<string> {
  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await raw.connect();
  raws.push(raw);
  const messageId = `${randomUUID()}@example.test`;
  await raw.append("INBOX", eml({ from: "news@example.test", to: cfg.auth.user, subject, messageId, body }));
  return messageId;
}

describe("an install with no model configured", () => {
  it("offers no drafts, says so in the vocabulary every host shares, and calls nothing", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, freshDir(), m.fetchImpl);

    const status = await (await l.client.fetch("/local/ai", { headers: auth(l) })).json() as {
      provider: string | null; available: boolean; unavailableReason: string; contentGoesTo: string | null;
    };
    expect(status.provider).toBeNull();
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("not_configured");
    expect(status.contentGoesTo).toBeNull();

    await l.sidecar.start();
    await deliver(cfg, "This week in email", "the weekly roundup, as ever");
    await l.sidecar.syncUntilQuiet();

    const rows = await l.sidecar.db.select({ id: messages.id }).from(messages);
    expect(rows.length, "the mail did not arrive at all").toBeGreaterThan(0);

    const draft = await l.client.fetch(`/messages/${rows[0]!.id}/draft`, { method: "POST", headers: auth(l) });
    expect(draft.status).toBe(503);
    expect((await draft.json() as { error: { code: string } }).error.code).toBe("drafter_unconfigured");

    // A full ingest, a Screener decision and a refused draft request — and not one byte left this
    // machine for a model. That is the claim, and the counter is the only form of it that is
    // evidence.
    expect(m.calls).toHaveLength(0);
  }, 60_000);
});

describe("configuring a key you own", () => {
  it("saves, verifies and reports in one round trip — and seals the key on disk", async () => {
    const cfg = greenmail();
    const dir = freshDir();
    const m = model();
    const l = await launch(cfg, dir, m.fetchImpl);

    const res = await l.client.fetch("/local/ai", {
      method: "PUT",
      headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const status = JSON.parse(body) as {
      available: boolean; contentGoesTo: string; settings: { anthropic: { hasKey: boolean } };
      probe: { ok: boolean; models: string[] };
    };

    expect(status.available).toBe(true);
    expect(status.probe.ok).toBe(true);
    expect(status.settings.anthropic.hasKey).toBe(true);
    // The settings surface is told where content goes by the thing that sends it, not by an
    // interface deciding for itself from a provider name.
    expect(status.contentGoesTo).toBe("anthropic");
    // The key came in on this request and is in no part of the answer.
    expect(body).not.toContain(KEY);

    // Verification is free: it lists and asks, and never runs a completion.
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
    expect(m.calls.some((c) => c.url.endsWith("/v1/messages"))).toBe(false);

    expect(readdirSync(dir)).toContain(AI_STORE_FILE);
    expect(readFileSync(join(dir, AI_STORE_FILE), "utf8")).not.toContain(KEY);
  }, 60_000);

  it("then drafts a reply through it, with the key on the request and nowhere else", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, freshDir(), m.fetchImpl);
    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });

    await l.sidecar.start();
    await deliver(cfg, "Are you free on Thursday?", "Could we move the review to Thursday morning?");
    await l.sidecar.syncUntilQuiet();
    const [row] = await l.sidecar.db.select({ id: messages.id }).from(messages);
    expect(row, "the mail did not arrive at all").toBeDefined();

    const res = await l.client.fetch(`/messages/${row!.id}/draft`, {
      method: "POST",
      headers: { ...auth(l), "idempotency-key": randomUUID() },
    });
    const draftBody = await res.text();
    expect(res.status, draftBody).toBe(202);
    const { draftId } = JSON.parse(draftBody) as { draftId: string };
    expect(draftId).toBeTruthy();

    const call = m.calls.find((c) => c.url.endsWith("/v1/messages"));
    expect(call, "no model request was made for the draft").toBeDefined();
    // The address is a literal in the provider and no setting reaches it.
    expect(call!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call!.headers["x-api-key"]).toBe(KEY);
    expect(call!.headers["anthropic-version"]).toBeTruthy();

    // The draft is STORED for review. Nothing sends.
    const stored = await l.client.fetch(`/drafts/${draftId}`, { headers: auth(l) });
    expect(stored.status).toBe(200);
  }, 60_000);

  it("buys a Screener suggestion through it, and stores the verdict", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, freshDir(), m.fetchImpl);
    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });

    await l.sidecar.start();
    await deliver(cfg, "This week in email", "the weekly roundup, as ever");
    await l.sidecar.syncUntilQuiet();

    // First contact is held at the Screener by RULE, deterministically — the model is not asked
    // and must not be. The suggestion is a separate, explicit request about senders already
    // waiting there, which is the second of this app's two AI features.
    const res = await l.client.fetch("/screener/suggest", {
      method: "POST",
      headers: auth(l),
      body: JSON.stringify({ senders: ["news@example.test"] }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text) as { suggestions: Array<{ sender: string; decision: string }> };
    expect(body.suggestions.map((s) => s.sender)).toContain("news@example.test");

    const call = m.calls.find((c) => c.url.endsWith("/v1/messages"));
    expect(call, "no model request was made for the suggestion").toBeDefined();
    expect(call!.headers["x-api-key"]).toBe(KEY);

    /* ── AND IT IS THE SCREENING QUESTION, THROUGH THE WHOLE ASSEMBLY ────────────────────────
       Route → service → port → transport, in one process, with nothing constructed privately. The
       service prefers `screen` and falls back to `classify` when a port lacks it, and that fallback
       is silent and safe — so a regression that dropped the method from the local port would land
       here as a WRONG PROMPT on the wire rather than as a failing call. The prefix is compared
       against core's own export byte for byte: two hosts asking one question in two wordings is a
       defect neither host's suite can see on its own. */
    const req = JSON.parse(call!.body) as {
      system?: Array<{ text?: string }>;
      output_config?: { format?: { schema?: { properties?: { destination?: { enum?: string[] } } } } };
    };
    expect(req.system?.[0]?.text, "the suggestion asked the routing question").toBe(SCREENING_PREFIX);
    expect(req.system?.[0]?.text).not.toBe(TAXONOMY_PREFIX);
    // The gate is what is being asked, so it cannot also be an answer.
    expect(req.output_config?.format?.schema?.properties?.destination?.enum).toEqual(SCREEN_DESTINATIONS);

    // The verdict is stored as an inert record: a suggestion, never a filing.
    const decisions = await l.sidecar.db
      .select({ status: routingDecisions.status, provenance: routingDecisions.inputProvenance })
      .from(routingDecisions);
    expect(decisions.some((d) => d.status === "suggestion"), JSON.stringify(decisions)).toBe(true);
  }, 60_000);
});

describe("a model that stops answering does not stop the mail", () => {
  it("files the next message on rules and lets the sync cursor advance", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, freshDir(), m.fetchImpl);
    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });
    await l.sidecar.start();

    // The model dies AFTER it has been verified — a revoked key, a laptop asleep, a local model
    // server somebody quit. Every one of those is a steady state on a personal machine, which is
    // why "abort the batch and re-plan" cannot be the end of the story.
    m.broken.value = true;

    for (let i = 0; i < 6; i++) {
      await deliver(cfg, `Bulletin ${i}`, "another roundup nobody asked for");
      // Faults are expected here; what must not happen is the loop giving up for good.
      await l.sidecar.syncUntilQuiet().catch(() => undefined);
    }

    const arrived = await l.sidecar.db.select({ id: messages.id }).from(messages);
    expect(
      arrived.length,
      "mail stopped arriving because the model stopped answering — this is the wedge",
    ).toBeGreaterThan(0);

    // And the install is still usable: the request path answers, it does not hang.
    const status = await (await l.client.fetch("/local/ai", { headers: auth(l) })).json() as {
      available: boolean;
    };
    expect(typeof status.available).toBe("boolean");
  }, 120_000);

  it("forgetting the provider takes the key with it and returns to rules-only", async () => {
    const cfg = greenmail();
    const dir = freshDir();
    const m = model();
    const l = await launch(cfg, dir, m.fetchImpl);
    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });

    const res = await l.client.fetch("/local/ai", { method: "DELETE", headers: auth(l) });
    expect(res.status).toBe(200);
    const status = await res.json() as { provider: string | null; settings: { anthropic: { hasKey: boolean } } };
    expect(status.provider).toBeNull();
    expect(status.settings.anthropic.hasKey).toBe(false);

    const onDisk = readFileSync(join(dir, AI_STORE_FILE), "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(JSON.parse(onDisk)).toMatchObject({ provider: null, anthropic: { keyEnc: null } });
  }, 60_000);
});

describe("OpenCode Go drafts through the desktop's draft wire", () => {
  /* The window's "Draft reply" is draftReplyVia (#39) over the bridge: one wire for every provider.
     Here it runs against the engine with Go configured, so the draft comes from Go's chat endpoint. */
  it("creates and reads a draft written by the Go model", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, freshDir(), m.fetchImpl);
    const goKey = "fixture-go-key-ai-local";
    const saved = await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({
        provider: "opencode-go", opencodeGo: { apiKey: goKey, classifyModel: "glm-5.3-flash", draftModel: "kimi-k3" },
      }),
    });
    expect((await saved.json() as { available: boolean }).available).toBe(true);

    await l.sidecar.start();
    await deliver(cfg, "Are you free on Thursday?", "Could we move the review to Thursday morning?");
    await l.sidecar.syncUntilQuiet();
    const [row] = await l.sidecar.db.select({ id: messages.id }).from(messages);
    expect(row, "the mail did not arrive at all").toBeDefined();

    const wire = draftReplyVia(
      (path, init) => l.client.fetch(path, { ...init, headers: { ...auth(l), ...(init?.headers as Record<string, string>) } }),
      () => true,
      "noModelHere",
    );
    const { draftId } = await wire.create(row!.id, randomUUID());
    expect(await wire.read(draftId)).toMatchObject({ body: expect.stringContaining("Thursday works.") });

    const drafts = m.calls.filter((c) => c.url === "https://opencode.ai/inference/go/v1/chat/completions"
      && c.body.includes("kbEntries"));
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0]!.body)).toMatchObject({ model: "kimi-k3" });
    expect(drafts[0]!.headers.authorization).toBe(`Bearer ${goKey}`);
  }, 60_000);
});
