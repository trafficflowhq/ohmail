import { bridgeFetch } from "../../../test/support/desktop-bridge-fixtures.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";
import { messages, routingDecisions } from "@trafficflow/db";
import { AI_STORE_FILE } from "../src/ai-provider.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { readAiStatus, saveAiSettings } from "../../../test/support/desktop-bridge-fixtures.js";
import {
  hydrateSuggestions, runSuggest, CHUNK, type SuggestionRow,
} from "../../../test/support/desktop-bridge-fixtures.js";

/**
 * THE WINDOW'S OWN CODE AGAINST THE REAL ENGINE — the join neither side's suite covered.
 *
 * The desktop app's tests drive its settings client and its suggest loop against a stand-in engine;
 * this engine's tests drive its routes through a client written beside them. Both were green while
 * the two could not actually talk: the window addresses the engine with root-relative paths, and
 * the engine builds what arrives with the platform's `Request`, which rejects one. Every layer
 * agreed with itself and nothing checked the seam.
 *
 * So this drives the SHIPPED window modules — `local-ai.ts` and `local-suggest-run.ts`, exactly as
 * they are compiled into the app — against a REAL engine on a REAL mailbox, through a stand-in for
 * the native shell that does what the native shell does and nothing more: compose the path against
 * the base the engine announced, add the session token the window never sees, and hand the answer
 * back as bytes. The shell's half of that is pinned separately, in Rust, against a child process
 * over a real pipe (`apps/desktop/src-tauri/src/engine_tests.rs`).
 *
 * ── THE MODEL IS THE ONE THING STANDING IN ──────────────────────────────────────────────────
 *
 * Injected at the transport, so what is asserted is the request that would have left this machine —
 * its address, its headers, and that it happened at all. A test that reached a real endpoint would
 * spend somebody's money on every run and fail for reasons that have nothing to do with this code.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const KEY = anthropicKey("desktop-ai-bridge");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

/** The base the engine announces when it starts serving. The shell composes against this one. */
const ANNOUNCED_BASE = "http://sidecar";

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown };
}
const host = globalThis as unknown as Host;

function greenmail() {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false as const,
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

interface Call { url: string; headers: Record<string, string> }

/** The stand-in model. Records every request; answers the endpoints the provider speaks. */
function model(): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url, headers });
    const json = (b: unknown): Response =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (/\/v1\/models\?/.test(url)) return json({ data: [{ id: "claude-haiku-4-5-20251001" }] });
    if (/\/v1\/models\//.test(url)) return json({ id: "ok" });
    if (/\/v1\/messages$/.test(url)) {
      return json({
        content: [{
          type: "text",
          text: JSON.stringify({
            destination: "ohmail/News", confidence: 0.9, rationale: "a newsletter", spam: false,
          }),
        }],
      });
    }
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

interface Crossed { method: string; url: string }

/**
 * A stand-in for the native shell, doing exactly the three things the real one does.
 *
 * Deliberately NOT a re-implementation of the engine or of the client: it composes the path against
 * the announced base, replaces any authorization the caller supplied with the engine's own token,
 * and hands the answer back as the length-prefixed bytes the window decodes. Every other decision
 * belongs to one of the two real halves this test is joining.
 */
function shellAround(sidecar: Sidecar): Crossed[] {
  const crossed: Crossed[] = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") {
        return {
          state: "serving", mode: "local",
          mailboxId: sidecar.world.mailboxId, credentialState: "ready",
        };
      }
      if (command !== "engine_request") return null;
      const asked = String(payload?.url ?? "");
      const method = String(payload?.method ?? "GET").toUpperCase();
      crossed.push({ method, url: asked });
      const url = asked.startsWith("/") ? `${ANNOUNCED_BASE}${asked}` : asked;
      const headers = new Headers();
      for (const [name, value] of (payload?.headers as Array<[string, string]>) ?? []) {
        // THE CALLER DOES NOT GET TO SUPPLY THIS ONE — the shell's rule, mirrored.
        if (name.toLowerCase() === "authorization") continue;
        headers.append(name, value);
      }
      headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
      const body = Uint8Array.from((payload?.body as number[]) ?? []);
      const carries = body.byteLength > 0 && method !== "GET" && method !== "HEAD";
      const res = await sidecar.handle(new Request(url, { method, headers, ...(carries ? { body } : {}) }));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const meta = new TextEncoder().encode(JSON.stringify({
        status: res.status, statusText: res.statusText, h: [...res.headers],
      }));
      const out = new Uint8Array(4 + meta.byteLength + bytes.byteLength);
      new DataView(out.buffer).setUint32(0, meta.byteLength, false);
      out.set(meta, 4);
      out.set(bytes, 4 + meta.byteLength);
      return out;
    },
  };
  return crossed;
}

const open: Sidecar[] = [];
const dirs: string[] = [];
const raws: ImapFlow[] = [];

afterEach(async () => {
  delete host.__TAURI_INTERNALS__;
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
  for (const c of raws.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function launch(
  cfg: ReturnType<typeof greenmail>,
  fetchImpl: typeof fetch,
): Promise<{ sidecar: Sidecar; dir: string }> {
  const dir = await freshDataDir("ohmail-desktop-ai-");
  dirs.push(dir);
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: cfg,
    address: cfg.auth.user,
    displayName: "This Mac",
    keks: { 1: aKek() },
    fetchImpl,
    // Long enough that no poll fires on its own: every cycle here is one a case asked for.
    pollIntervalMs: 60 * 60 * 1000,
  });
  await grantOrganizeConsent(sidecar);
  open.push(sidecar);
  return { sidecar, dir };
}

async function deliver(cfg: ReturnType<typeof greenmail>, from: string, subject: string): Promise<void> {
  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await raw.connect();
  raws.push(raw);
  await raw.append("INBOX", eml({
    from, to: cfg.auth.user, subject,
    messageId: `${randomUUID()}@example.test`, body: "the weekly roundup, as ever",
  }));
}

describe("the desktop window's own modules, against the engine they ship beside", () => {
  it("sets up a model and asks it about waiting senders, all over the bridge", async () => {
    const cfg = greenmail();
    const m = model();
    const { sidecar, dir } = await launch(cfg, m.fetchImpl);
    const crossed = shellAround(sidecar);

    /* ── 1 · a fresh install has no model, and says so rather than failing ─────────────────── */
    const before = await readAiStatus();
    expect(before, "the engine did not answer the settings read").not.toBeNull();
    expect(before!.provider).toBeNull();
    expect(before!.unavailableReason).toBe("not_configured");
    expect(before!.contentGoesTo).toBeNull();

    /* EVERY PATH THE WINDOW SENDS IS ROOT-RELATIVE — the shape the shell has to compose and the
       engine cannot parse on its own. This is the assertion the whole file exists for; before the
       shell learned to compose, this request came back as a transport failure. */
    expect(crossed.every((c) => c.url.startsWith("/")), JSON.stringify(crossed)).toBe(true);

    /* ── 2 · configuring one verifies in the same round trip, and the key is never handed back ─ */
    const saved = await saveAiSettings({ provider: "anthropic", anthropic: { apiKey: KEY } });
    expect(saved.available, JSON.stringify(saved.probe)).toBe(true);
    expect(saved.settings.anthropic.hasKey).toBe(true);
    expect(saved.contentGoesTo).toBe("anthropic");
    expect(saved.probe?.models ?? []).toContain("claude-haiku-4-5-20251001");
    expect(JSON.stringify(saved), "the key came back in the status").not.toContain(KEY);
    expect(readFileSync(join(dir, AI_STORE_FILE), "utf8"), "the key is on disk in the clear")
      .not.toContain(KEY);
    // The verification lists and asks. It never runs a completion, so saving costs nothing.
    expect(m.calls.some((c) => c.url.endsWith("/v1/messages"))).toBe(false);

    /* ── 3 · real first-contact mail arrives and is held by RULE, with no model asked ───────── */
    await sidecar.start();
    const senders = ["news@example.test", "digest@example.test", "letters@example.test"];
    for (const [i, from] of senders.entries()) await deliver(cfg, from, `Bulletin ${i}`);
    await sidecar.syncUntilQuiet();
    const arrived = await sidecar.db.select({ id: messages.id }).from(messages);
    expect(arrived.length, "the mail did not arrive at all").toBe(senders.length);
    expect(
      m.calls.some((c) => c.url.endsWith("/v1/messages")),
      "routing asked a model — first contact is held by rule, deterministically",
    ).toBe(false);

    /* ── 4 · and the window's own loop asks about them ──────────────────────────────────────── */
    const consent = await bridgeFetch("/consent/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoSuggest: true }),
    });
    expect(consent.ok).toBe(true);
    const landed: SuggestionRow[] = [];
    const ticks: Array<[number, number]> = [];
    const out = await runSuggest({
      senders,
      absorb: (rows) => landed.push(...rows),
      onProgress: (done, total) => ticks.push([done, total]),
    });

    expect(out.refusal, JSON.stringify(out.refusal)).toBeNull();
    expect(out.abandoned).toBe(false);
    expect(out.done).toBe(senders.length);
    expect(landed.map((r) => r.address).sort()).toEqual([...senders].sort());
    // Every one of them carries a real destination rather than the no-action arm, which is what
    // proves the mapping table read the engine's answer instead of falling through it.
    expect(landed.every((r) => r.suggestion.dest === "reads"), JSON.stringify(landed)).toBe(true);
    // Progress ticked from zero, so the surface has something to paint before the end.
    expect(ticks[0]).toEqual([0, senders.length]);

    /* One model call per sender, under the key typed into the pane and sent nowhere else. */
    const asked = m.calls.filter((c) => c.url.endsWith("/v1/messages"));
    expect(asked).toHaveLength(senders.length);
    for (const call of asked) {
      expect(call.url).toBe("https://api.anthropic.com/v1/messages");
      expect(call.headers["x-api-key"]).toBe(KEY);
    }

    /* Stored as an inert record: a suggestion, never a filing. */
    const decisions = await sidecar.db
      .select({ status: routingDecisions.status })
      .from(routingDecisions);
    expect(decisions.some((d) => d.status === "suggestion"), JSON.stringify(decisions)).toBe(true);

    /* ── 5 · the answers survive, and asking again costs nothing ────────────────────────────── */
    const stored = await hydrateSuggestions();
    expect(stored.map((r) => r.address).sort()).toEqual([...senders].sort());

    const before2 = asked.length;
    const again = await runSuggest({ senders, absorb: () => {} });
    expect(again.refusal).toBeNull();
    expect(
      m.calls.filter((c) => c.url.endsWith("/v1/messages")).length,
      "a re-run asked the model again for senders it had already answered for",
    ).toBe(before2);

    /* ── 6 · the requests were small and serial ─────────────────────────────────────────────── */
    const posts = crossed.filter((c) => c.url === "/screener/suggest");
    expect(posts.length).toBe(2 * Math.ceil(senders.length / CHUNK));
  }, 180_000);

  it("refuses in the engine's own words when this install has no model", async () => {
    const cfg = greenmail();
    const m = model();
    const { sidecar } = await launch(cfg, m.fetchImpl);
    shellAround(sidecar);
    await sidecar.start();
    await deliver(cfg, "news@example.test", "This week in email");
    await sidecar.syncUntilQuiet();

    const out = await runSuggest({ senders: ["news@example.test"], absorb: () => {} });
    expect(out.done).toBe(0);
    // The engine names it in the vocabulary every host shares, and the window carries that word
    // out rather than inventing a class of its own — which is what tells the control to offer the
    // settings pane instead of "try again".
    expect(out.refusal?.code).toBe("suggest_unconfigured");
    expect(out.refusal?.noModel).toBe(true);
    expect(m.calls, "an install with no model reached one anyway").toHaveLength(0);
  }, 120_000);
});
