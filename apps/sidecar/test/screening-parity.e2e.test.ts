import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";
import { contacts, folderState, messages, rules } from "@trafficflow/db/mail";
import {
  SCREEN_DESTINATIONS, SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
} from "@trafficflow/core/mail";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { runSuggest, type SuggestionRow } from "../../desktop/src/local-suggest-run.js";
import { readScreening, saveOhboxBar } from "../../desktop/src/local-screening.js";

/**
 * THE DESKTOP ASKS THE SAME SCREENING QUESTION CLOUD ASKS — proved on the wire, both providers.
 *
 * The Screener's suggestion path stopped asking the ROUTING question: `ohmail/Screener` is what the
 * routing taxonomy DEFINES as the answer for a first-contact sender, and every row that path can
 * reach is a first-contact sender, so the model was being asked a question with its answer built in
 * and gave that answer most of the time. `ClassifierPort` grew a second method, `screen`, for the
 * question a person standing at the gate is actually asking.
 *
 * That method is OPTIONAL on the port — a compatibility statement, because a `ClassifierPort` is
 * implemented outside the package that declares it — and `ScreenerService.suggest` falls back to
 * `classify` when it is absent. The fallback degrades advice without endangering anything, which is
 * exactly what makes its absence invisible: a standalone install whose providers had never been
 * taught the second question kept answering the first one, correctly, forever, and nothing failed.
 *
 * So this file asserts the QUESTION rather than the answer, at the transport, for both of the two
 * ways a standalone install reaches a model.
 *
 * ── WHAT EACH ASSERTION IS FOR ──────────────────────────────────────────────────────────────
 *
 *  · **The drift guard.** The prefix on the wire is compared BYTE FOR BYTE against the constant
 *    `@trafficflow/core/mail` exports. Not "contains a phrase" — identical. Two hosts asking one
 *    question in two slightly different wordings is a defect no test of either host alone can see,
 *    because each passes its own; the only way to catch it is to compare against the shared source.
 *    Mutation: append a sentence in either provider, or swap the import for a local string, and
 *    both providers go red here.
 *  · **The question is the screening one and not the routing one.** Asserted twice over: the prefix
 *    is not `TAXONOMY_PREFIX`, and the answer set on the request is the five-pile screening one
 *    with `ohmail/Screener` REMOVED. The second is the sharper of the two — the removal of that
 *    label from the enum is the whole mechanical difference between the two questions.
 *  · **The user's own words reach the model.** The account's bar travels in the USER turn, never in
 *    the cached prefix, and on this question it is binding criteria rather than one input among
 *    several.
 *  · **AND THE INSTALL CAN SET THEM.** The bar is no longer seeded into the database by this file:
 *    it is written through `GET/PATCH /account/screening` on the local engine, by the same
 *    `local-screening.ts` the settings editor calls, over the same shell bridge the window uses.
 *    That closes the half of this feature that was never true on this tier — the words steering a
 *    model the user pays for were readable and unwritable — and it makes the two claims one
 *    sequence: the words were saved over the bridge, and then a model was asked using them.
 *  · **Redaction happens while assembling the provider payload.** The credential value is
 *    absent from the request and the subject matter reaches the model. Storage keeps the original.
 *
 * ── THE MODEL ANSWERS THE QUESTION IT WAS ASKED, WHICH IS WHY A FALLBACK IS VISIBLE ──────────
 *
 * The stand-in reads the prefix off the request and replies as the real one measurably did: a real
 * pile for the screening question, and `ohmail/Screener` — the tautology — for the routing one. So
 * an install that fell back to `classify` produces `hold` and this file goes red on the ANSWER as
 * well as on the request. That is deliberate: it is the user-visible half of the defect, and a test
 * that only inspected the prompt would pass on a build that had stopped calling `screen`.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const KEY = anthropicKey("screening-parity");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

/** The same code appears in both the stored subject and the message preview. */
const CODE = "482913";
const CREDENTIAL_SUBJECT = `Your sign-in code is ${CODE}`;
const CREDENTIAL_BODY = `Use ${CODE} to sign in. The code expires in ten minutes.`;
const CREDENTIAL_SENDER = "security@bank.test";

/** The account's own bar, in their words. Binding criteria on this question. */
const THE_BAR = "Only real people writing to me personally, plus anything about my bank account.";

/**
 * A sender this mailbox has ALREADY ADMITTED, and the reason the filing cases below need one.
 *
 * `evaluateRules` answers `ohmail/Screener` for anybody it does not recognise, and a decided
 * destination is exactly what stops the pipeline consulting a model at all. So mail from a
 * stranger can never exercise the filing loop's classifier, and mail from a stranger can never be
 * demoted by the posture either — both of those live PAST the consent gate, which is the whole
 * design. Admitting the sender first is therefore not a shortcut around the gate; it is the only
 * way to stand in the place where these two settings do anything.
 */
const KNOWN_SENDER = "vanessa@friends.test";
/** A sender admitted by an INFERRED rule — the only kind the posture is allowed to refine. */
const BULK_SENDER = "news@shop.test";

/** The base the engine announces when it starts serving. The shell composes against this one. */
const ANNOUNCED_BASE = "http://sidecar";

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

function eml(o: {
  from: string; to: string; subject: string; messageId: string; body: string;
  /** Extra header lines, verbatim. Used to give a message the bulk shape a newsletter has. */
  extraHeaders?: string[];
}): string {
  return [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    ...(o.extraHeaders ?? []),
    "",
    o.body,
  ].join("\r\n");
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

/**
 * The stand-in model, for both providers, recording every request in full.
 *
 * The BODY is kept, which the sibling e2e files do not need and this one is entirely about: the
 * claim under test is what the request said, not that one was made.
 */
function model(): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
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

    /* ── Anthropic: the two free verification reads ───────────────────────────────────────── */
    if (/\/v1\/models\?/.test(url)) return json({ data: [{ id: "claude-haiku-4-5-20251001" }] });
    if (/\/v1\/models\//.test(url)) return json({ id: "ok" });
    /* ── Ollama: the free verification read ──────────────────────────────────────────────── */
    if (/\/api\/tags$/.test(url)) return json({ models: [{ name: "llama3.2:latest" }] });

    /**
     * ANSWER THE QUESTION THAT WAS ACTUALLY ASKED.
     *
     * Read off the prefix rather than off the endpoint, because both questions travel to the same
     * endpoint under both providers. The routing reply is the tautology the live model gave — the
     * gate's own name — so a build that fell back to `classify` is visible in the ANSWER, not only
     * in the request. See the file header.
     */
    const asked = screeningWasAsked(body) ? "screen" : "classify";
    const verdict = asked === "screen"
      ? { destination: "INBOX", confidence: 0.88, rationale: "your bank, writing about your account", spam: false }
      : { destination: "ohmail/Screener", confidence: 0.91, rationale: "a first-contact sender", spam: false };

    if (/\/v1\/messages$/.test(url)) return json({ content: [{ type: "text", text: JSON.stringify(verdict) }] });
    if (/\/api\/chat$/.test(url)) return json({ message: { content: JSON.stringify(verdict) } });
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** The system prefix a recorded completion carried, whichever provider shaped the request. */
function prefixOf(body: string): string {
  const b = JSON.parse(body) as {
    system?: Array<{ text?: string }>;
    messages?: Array<{ role?: string; content?: string }>;
  };
  // Anthropic puts it in a cacheable `system` block; Ollama sends it as the first chat message.
  if (Array.isArray(b.system)) return b.system[0]?.text ?? "";
  return b.messages?.find((m) => m.role === "system")?.content ?? "";
}

/** The user turn a recorded completion carried, parsed. */
function userTurnOf(body: string): Record<string, unknown> {
  const b = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
  const raw = b.messages?.find((m) => m.role === "user")?.content ?? "{}";
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The response schema a recorded completion constrained its answer to. */
function schemaOf(body: string): { properties?: { destination?: { enum?: string[] } } } {
  const b = JSON.parse(body) as {
    output_config?: { format?: { schema?: unknown } };
    format?: unknown;
  };
  return (b.output_config?.format?.schema ?? b.format ?? {}) as { properties?: { destination?: { enum?: string[] } } };
}

const screeningWasAsked = (body: string): boolean => body !== "" && prefixOf(body) === SCREENING_PREFIX;

interface Launch { sidecar: Sidecar; host: StdioHost; client: StdioClient; dir: string }

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface HostGlobal { __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown } }
const hostGlobal = globalThis as unknown as HostGlobal;

const open: Launch[] = [];
const dirs: string[] = [];
const raws: ImapFlow[] = [];

afterEach(async () => {
  delete hostGlobal.__TAURI_INTERNALS__;
  for (const l of open.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const c of raws.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function launch(
  cfg: ReturnType<typeof greenmail>,
  fetchImpl: typeof fetch,
): Promise<Launch> {
  const dir = await freshDataDir("ohmail-screening-");
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
  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: ANNOUNCED_BASE });
  const l: Launch = { sidecar, host, client, dir };
  open.push(l);
  return l;
}

const auth = (l: Launch): Record<string, string> => ({
  authorization: `Bearer ${l.sidecar.sessionToken}`,
  "content-type": "application/json",
});

/**
 * A stand-in for the native shell, doing exactly the three things the real one does: compose the
 * root-relative path against the announced base, replace any authorization the caller supplied with
 * the engine's own token, and hand the answer back as the length-prefixed bytes the window decodes.
 */
function shellAround(sidecar: Sidecar): void {
  hostGlobal.__TAURI_INTERNALS__ = {
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
      const url = asked.startsWith("/") ? `${ANNOUNCED_BASE}${asked}` : asked;
      const headers = new Headers();
      for (const [name, value] of (payload?.headers as Array<[string, string]>) ?? []) {
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
}

async function deliver(
  cfg: ReturnType<typeof greenmail>,
  o: { from: string; subject: string; body: string; extraHeaders?: string[] },
): Promise<void> {
  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await raw.connect();
  raws.push(raw);
  await raw.append("INBOX", eml({
    from: o.from, to: cfg.auth.user, subject: o.subject,
    messageId: `${randomUUID()}@example.test`, body: o.body,
    ...(o.extraHeaders ? { extraHeaders: o.extraHeaders } : {}),
  }));
}

async function deliverCredentialMail(cfg: ReturnType<typeof greenmail>): Promise<void> {
  await deliver(cfg, { from: CREDENTIAL_SENDER, subject: CREDENTIAL_SUBJECT, body: CREDENTIAL_BODY });
}

/**
 * Admit a sender the way this mailbox's own history would have: a `contacts` row.
 *
 * The pipeline reads exactly this table for `knownSenders`, and a row in it is what the consent
 * gate treats as "already past". Written directly because the alternative — sending mail from this
 * install and letting the ingest of Sent record the contact — would put a second, unrelated ingest
 * in front of the assertion, and this file's subject is what happens on the way IN.
 */
async function admit(l: Launch, address: string): Promise<void> {
  await l.sidecar.db.insert(contacts).values({ accountId: l.sidecar.world.accountId, address });
}

/** Where the engine decided a message belongs, by its `Message-ID`-free subject. */
async function filedFolder(l: Launch, subject: string): Promise<string | undefined> {
  const [row] = await l.sidecar.db
    .select({ id: messages.id }).from(messages).where(eq(messages.subject, subject)).limit(1);
  if (!row) return undefined;
  const [state] = await l.sidecar.db
    .select({ desired: folderState.desiredFolder }).from(folderState)
    .where(eq(folderState.messageId, row.id)).limit(1);
  return state?.desired;
}

/**
 * Which of the named folders on the REAL server hold a message with this subject.
 *
 * The folder list is passed in rather than discovered, because a server's own list contains
 * containers it will not let anyone SELECT (`ohmail` itself, `\Noselect`), and a helper that
 * swallowed that failure would also swallow the failure this is looking for. The two folders that
 * matter to the caller are the two the caller names.
 *
 * **The names are SERVER paths, not canonical ones.** GreenMail publishes its tree with a `.`
 * delimiter, so the folder the engine calls `ohmail/News` is `ohmail.News` over the wire — the
 * adapter translates at the boundary (`imap.ts:635`). Selecting a folder that does not exist
 * answers a bare "Command failed", which is indistinguishable from a folder that exists and could
 * not be read, so passing a canonical path here fails in a way that looks like a product defect.
 */
async function serverFoldersHolding(
  cfg: ReturnType<typeof greenmail>, subject: string, folders: string[],
): Promise<string[]> {
  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await raw.connect();
  raws.push(raw);
  const found: string[] = [];
  for (const path of folders) {
    const lock = await raw.getMailboxLock(path);
    try {
      const hits = await raw.search({ subject });
      if (hits && hits.length > 0) found.push(path);
    } finally {
      lock.release();
    }
  }
  return found;
}

/**
 * The account's bar, WRITTEN THE WAY THE APP WRITES IT — the settings editor's own save path.
 *
 * `account_settings.ohbox_bar` is a MAIL-half column (mail 0042) and `db.ts` migrates the mail
 * journal, so it has been present in every local install's database from the day it was created and
 * `getScreeningPreference` has always read it exactly as the hosted service does. What a standalone
 * install had no way to do was WRITE one: `screeningRoutes` was mounted in the hosted route table
 * and not in `localRoutes`, so this helper used to `INSERT` the value straight into the mirror and
 * the file said, in as many words, that the seeding would become a request the day the route was
 * mounted. It is that request now.
 *
 * And it is deliberately not a hand-rolled one. `saveOhboxBar` is the exact function
 * `DesktopScreeningWords`'s Save button calls, over the exact bridge the window uses, so this
 * covers the whole path — editor → `bridgeFetch` → the shell's `engine_request` → the sidecar's
 * router → `localRoutes` → `setScreeningPreference` — rather than the last inch of it. Deleting the
 * `screeningRoutes` line from `localRoutes` fails HERE, on a 404, before any assertion about a
 * model is reached; and so does deleting the PATCH from `local-screening.ts`.
 *
 * The read on either side of the write is what makes the assertion about the ROUTE and not about
 * the database: an install that answered the GET from a default and dropped the PATCH would pass a
 * write-only check.
 */
async function setTheBar(l: Launch, bar: string): Promise<void> {
  /* The window's transport needs the shell around it. The Anthropic case installs this already for
     `runSuggest`; the Ollama case does not, and calling it twice is a plain re-assignment. */
  shellAround(l.sidecar);

  const before = await readScreening();
  expect(before.state, "the local engine does not serve GET /account/screening").toBe("ready");
  const pref = (before as { state: "ready"; pref: { ohboxBar: string | null; defaultBar: string } }).pref;
  expect(pref.ohboxBar, "a freshly created install already had a bar").toBeNull();
  expect(pref.defaultBar.length, "the read carried no product default to prefill with")
    .toBeGreaterThan(0);

  const landed = await saveOhboxBar(bar);
  expect(landed.ohboxBar, "the PATCH answered without the words it was given").toBe(bar);

  const reread = await readScreening();
  expect(reread.state).toBe("ready");
  expect(
    (reread as { state: "ready"; pref: { ohboxBar: string | null } }).pref.ohboxBar,
    "the words did not survive the write",
  ).toBe(bar);
}

/** The one completion a suggestion caused, whichever provider carried it. */
function theCompletion(calls: Call[]): Call {
  const completions = calls.filter((c) => /\/v1\/messages$|\/api\/chat$/.test(c.url));
  expect(completions, "no model completion was made for the suggestion").toHaveLength(1);
  return completions[0]!;
}

describe("a standalone install asks the SCREENING question, under a key its owner supplies", () => {
  it("gives a credential sender a real answer, in the shared words, with the original preview", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, m.fetchImpl);
    shellAround(l.sidecar);

    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });
    await setTheBar(l, THE_BAR);

    await l.sidecar.start();
    await deliverCredentialMail(cfg);
    await l.sidecar.syncUntilQuiet();

    /* The window's own loop, over the shell, exactly as the app runs it. */
    const landed: SuggestionRow[] = [];
    const out = await runSuggest({ senders: [CREDENTIAL_SENDER], absorb: (rows) => landed.push(...rows) });

    expect(out.refusal, JSON.stringify(out.refusal)).toBeNull();
    expect(out.done, "the sender was skipped rather than answered for").toBe(1);

    /* ── 1 · A REAL ANSWER, not a non-answer, in the row the window actually paints ───────────
       `screener` is the row's own word for "there is nothing to act on here", and it is what the
       routing question produces for a first-contact sender BY CONSTRUCTION — so it is what this
       install painted on every one of these senders before it learned the second question. */
    expect(landed, JSON.stringify(landed)).toHaveLength(1);
    expect(landed[0]!.address).toBe(CREDENTIAL_SENDER);
    expect(
      landed[0]!.suggestion.dest,
      "the model was asked the routing question and answered the gate's own name",
    ).not.toBe("screener");
    expect(landed[0]!.suggestion.dest).toBe("ohbox");
    expect(landed[0]!.suggestion.noAnswer, "the row was painted as a non-answer").toBeUndefined();

    const call = theCompletion(m.calls);
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);

    /* ── 2 · THE DRIFT GUARD — byte for byte against the shared export ───────────────────────── */
    expect(
      prefixOf(call.body),
      "the local prefix has drifted from the one the hosted deployment sends",
    ).toBe(SCREENING_PREFIX);
    expect(prefixOf(call.body)).not.toBe(TAXONOMY_PREFIX);

    /* ── 3 · THE ANSWER SET IS THE SCREENING ONE — the gate is not offered as an answer ──────── */
    expect(schemaOf(call.body).properties?.destination?.enum).toEqual(SCREEN_DESTINATIONS);
    expect(schemaOf(call.body).properties?.destination?.enum).not.toContain("ohmail/Screener");

    /* ── 4 · THE USER'S OWN WORDS, in the user turn and never in the cached prefix ───────────── */
    const turn = userTurnOf(call.body);
    expect(turn.ohboxBar, "the account's bar never reached the model").toBe(THE_BAR);
    expect(
      prefixOf(call.body),
      "one account's words are in the prefix, which is cached and shared",
    ).not.toContain(THE_BAR);
    // The instruction ABOUT the field is in the prefix; the field's value is not.
    expect(prefixOf(call.body)).toContain("binding criteria");

    expect(call.body, "the one-time code reached the model").not.toContain(CODE);
    expect(turn.subject).toBe("Your sign-in code is [code]");
    expect(turn.snippet).toContain("Use [code] to sign in.");
    const [stored] = await l.sidecar.db.select().from(messages).where(eq(messages.fromAddress, CREDENTIAL_SENDER));
    expect(stored).toMatchObject({ subject: CREDENTIAL_SUBJECT, snippet: CREDENTIAL_BODY });
    expect(
      String(turn.subject),
      "the redaction took the subject matter with the value",
    ).toContain("sign-in code");
  }, 120_000);
});

describe("a standalone install asks the SAME question of a model on its own machine", () => {
  it("sends the shared screening prefix and schema to the local model server", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, m.fetchImpl);

    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "ollama", ollama: { classifyModel: "llama3.2", draftModel: "llama3.2" } }),
    });
    await setTheBar(l, THE_BAR);

    await l.sidecar.start();
    await deliverCredentialMail(cfg);
    await l.sidecar.syncUntilQuiet();

    const consent = await l.client.fetch("/consent/settings", {
      method: "PATCH", headers: auth(l), body: JSON.stringify({ autoSuggest: true }),
    });
    expect(consent.ok).toBe(true);

    const res = await l.client.fetch("/screener/suggest", {
      method: "POST",
      headers: { ...auth(l), "idempotency-key": randomUUID() },
      body: JSON.stringify({ senders: [CREDENTIAL_SENDER] }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text) as {
      suggestions: Array<{ sender: string; decision: string; destination?: string }>;
      skipped: Array<{ sender: string; reason: string }>;
    };
    expect(body.skipped, JSON.stringify(body.skipped)).toHaveLength(0);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]!.decision, "the local model was asked the routing question").not.toBe("hold");
    expect(body.suggestions[0]!.destination).toBe("INBOX");

    const call = theCompletion(m.calls);
    expect(call.url).toBe("http://127.0.0.1:11434/api/chat");

    /* THE SAME GUARD, on the provider whose destination is configurable — the two must not drift
       from the shared export or from each other. */
    expect(
      prefixOf(call.body),
      "the local model server was sent a different question from the one Anthropic is sent",
    ).toBe(SCREENING_PREFIX);
    expect(prefixOf(call.body)).not.toBe(TAXONOMY_PREFIX);
    expect(schemaOf(call.body)).toEqual(SCREENING_RESULT_SCHEMA);

    const turn = userTurnOf(call.body);
    expect(turn.ohboxBar).toBe(THE_BAR);
    expect(call.body, "the one-time code reached the model on this machine").not.toContain(CODE);
    expect(turn.subject).toBe("Your sign-in code is [code]");
    expect(turn.snippet).toContain("Use [code] to sign in.");
    const [stored] = await l.sidecar.db.select().from(messages).where(eq(messages.fromAddress, CREDENTIAL_SENDER));
    expect(stored).toMatchObject({ subject: CREDENTIAL_SUBJECT, snippet: CREDENTIAL_BODY });
  }, 120_000);
});

/**
 * THE SAME TWO SETTINGS, ON THE WAY IN — the filing loop, not the Screener button.
 *
 * Everything above is about the moment somebody PRESSES something: they ask the Screener what to
 * do with a waiting sender, and a model answers. That is one of the two places these settings are
 * supposed to reach, and it was the only one a standalone install ever wired.
 *
 * The other is ingest. Mail arriving on a laptop was filed by the lenient default posture and
 * judged, where it was judged at all, with no bar in the user turn — while the hosted service read
 * both from the account and threaded them through the same shared pipeline. Two hosts, one loop,
 * two different answers for the same mailbox: the divergence the single-pipeline rule exists to
 * prevent, arriving through the deps rather than through a second copy of the code.
 *
 * It was also a claim already in the tree. `local-screening.ts` told a reader, in as many words,
 * that "the POSTURE is honoured here — `runSyncCycle` resolves it per account and the pipeline
 * files against it". Nothing passed it. Both cases below are red without the read.
 *
 * ── WHY BOTH FIXTURES ADMIT THE SENDER FIRST ────────────────────────────────────────────────
 *
 * Neither setting can do anything to a stranger, by design: an unrecognised sender is answered
 * `ohmail/Screener` before either is consulted, and a decided destination is what stops the
 * pipeline asking a model at all. So the only place these settings act is past the consent gate,
 * and standing there is what these fixtures are for — not a way around it.
 */
describe("the mailbox's own screening settings reach the FILING loop", () => {
  /**
   * THE BAR, IN THE INGEST CLASSIFICATION'S USER TURN.
   *
   * The fixture is the ambiguous middle and nothing else: a sender this mailbox has admitted, no
   * rule naming them, no bulk marker, no money subject. That combination is the only one that
   * leaves `evaluateRules` with no answer, and an absent answer is the whole precondition for the
   * pipeline consulting a model. Anything more decided would file itself and prove nothing.
   *
   * The assertion is on the ROUTING question — the one ingest asks — which is why it looks for the
   * taxonomy prefix rather than reusing `theCompletion`: the screening prefix belongs to the
   * Screener path this file already covers, and a test that accepted either would pass on a build
   * where only the covered half worked.
   */
  it("carries the user's words into the classification the ARRIVING mail gets", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, m.fetchImpl);
    shellAround(l.sidecar);

    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });
    await setTheBar(l, THE_BAR);
    await admit(l, KNOWN_SENDER);

    const subject = "Are you around on Thursday";
    await l.sidecar.start();
    await deliver(cfg, { from: KNOWN_SENDER, subject, body: "Let me know either way." });
    await l.sidecar.syncUntilQuiet();

    const routing = m.calls.filter(
      (c) => /\/v1\/messages$/.test(c.url) && prefixOf(c.body) === TAXONOMY_PREFIX,
    );
    expect(
      routing,
      "arriving mail from an admitted sender that no rule settles asked no model at all",
    ).toHaveLength(1);

    const turn = userTurnOf(routing[0]!.body);
    expect(
      turn.ohboxBar,
      "the mailbox's own words never reached the model that judged its arriving mail",
    ).toBe(THE_BAR);
    /* THE PRIVACY HALF, and it is not a formality: the prefix is one cached block shared by every
       request this process makes, so one mailbox's sentence landing in it is a sentence that
       outlives the request that carried it. It belongs in the user turn or nowhere. */
    expect(
      prefixOf(routing[0]!.body),
      "one mailbox's words are in the cached prefix",
    ).not.toContain(THE_BAR);
  }, 120_000);

  /**
   * THE POSTURE, WITH NO MODEL ANYWHERE — and that absence is the point.
   *
   * The demotion is a rules-path decision: it needs the posture, an inferred admission, and a
   * message with the bulk shape, and it needs no model, no key and no network. An install that
   * never sets one up is exactly the install this has to work on, which is why this case
   * configures no provider at all.
   *
   * Asserted on the SERVER as well as in the mirror, because filing in place is the product's
   * claim and a `folder_state` row is only this engine's opinion of where the mail belongs.
   */
  it("files an admitted sender's bulk mail by the posture, on the server, with no model", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, m.fetchImpl);

    /* Through the engine's own route, the way a settings screen writes it — never an INSERT. The
       route is what a client can reach, and a test that seeded the column would stay green on a
       build where the write path was gone. */
    const patched = await l.client.fetch("/account/screening", {
      method: "PATCH", headers: auth(l), body: JSON.stringify({ ohboxPolicy: "people_only" }),
    });
    expect(patched.status, await patched.text()).toBe(200);

    /* The onboarding seed's shape: an INBOX rule this mailbox never typed, inferred from its own
       Sent mail. `provenance` is what the demotion is allowed to refine — a rule the user wrote by
       hand is never second-guessed — so this field is the fixture, not decoration. */
    await l.sidecar.db.insert(rules).values({
      accountId: l.sidecar.world.accountId,
      kind: "sender", match: BULK_SENDER, destination: "INBOX", provenance: "seeded-from-sent",
    });

    const subject = "This week at the shop";
    await l.sidecar.start();
    await deliver(cfg, {
      from: BULK_SENDER, subject, body: "New arrivals.",
      extraHeaders: ["List-Id: <news.shop.test>", "List-Unsubscribe: <https://shop.test/u>"],
    });
    await l.sidecar.syncUntilQuiet();

    expect(
      await filedFolder(l, subject),
      "the arriving newsletter kept the Ohbox the seeded rule names, so the posture never arrived",
    ).toBe("ohmail/News");

    const onServer = await serverFoldersHolding(cfg, subject, ["INBOX", "ohmail.News"]);
    expect(onServer, "the message was not moved on the server at all").toContain("ohmail.News");
    expect(onServer, "a copy was left in the Ohbox").not.toContain("INBOX");

    /* NO MODEL WAS ASKED ANYTHING. The demotion is deterministic, and a build that reached for one
       here would be spending somebody's key on a decision the headers already made. */
    expect(
      m.calls.filter((c) => /\/v1\/messages$|\/api\/chat$/.test(c.url)),
      "a model was consulted for a decision the rules had already made",
    ).toHaveLength(0);
  }, 120_000);

  /**
   * A SETTINGS READ THAT FAILS FILES LENIENTLY, AND SENDS NO BAR.
   *
   * The absent-config-selects-safe rule, at the one seam where it is a live decision rather than a
   * default: `people_only` is the STRICT posture, so a transient read fault that resolved to it
   * would demote a real person's mail on a blip. And the bar is dropped rather than carried over,
   * because a sentence from an earlier drain is criteria the database may no longer hold.
   *
   * The fault is injected by dropping the table the read names — the failure a corrupted mirror or
   * a half-applied migration actually produces — rather than by stubbing a function, so what is
   * being tested is the engine's behaviour and not a spy's.
   */
  it("files leniently, with no bar, when the settings read itself fails", async () => {
    const cfg = greenmail();
    const m = model();
    const l = await launch(cfg, m.fetchImpl);
    shellAround(l.sidecar);

    await l.client.fetch("/local/ai", {
      method: "PUT", headers: auth(l),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    });
    await setTheBar(l, THE_BAR);
    await admit(l, KNOWN_SENDER);
    await l.sidecar.db.execute("DROP TABLE account_settings");

    const subject = "Lunch on Friday";
    await l.sidecar.start();
    await deliver(cfg, { from: KNOWN_SENDER, subject, body: "Usual place?" });
    await l.sidecar.syncUntilQuiet();

    /* THE MAIL STILL ARRIVED. A settings read is not allowed to stop a mail app being one. */
    expect(await filedFolder(l, subject), "the drain died on a settings read").toBeDefined();

    const routing = m.calls.filter(
      (c) => /\/v1\/messages$/.test(c.url) && prefixOf(c.body) === TAXONOMY_PREFIX,
    );
    expect(routing, "the classification never happened").toHaveLength(1);
    expect(
      userTurnOf(routing[0]!.body).ohboxBar,
      "a bar the engine could not read was sent to the model anyway",
    ).toBeUndefined();
  }, 120_000);
});
