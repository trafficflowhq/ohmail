import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, accountSettings, mailboxes } from "@trafficflow/db";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { dbFor, ScreenerService, type ServiceContext } from "@trafficflow/services";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { cloudSuggestWire } from "../../../test/support/desktop-bridge-fixtures.js";
import { consentOverBridge } from "../../../test/support/desktop-bridge-fixtures.js";
import { FakeAdapter, seedMessage } from "../../../packages/services/test/helpers.js";
import { fakeSpendPort } from "../../../packages/services/test/helpers/spend-port-fake.js";
import { PLANE_PRICES, PLANE_PRICING } from "../../../packages/services/test/helpers/plane-pricing.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { tearDown } from "./_teardown.js";

/**
 * A CONFIRMED PURCHASE ON THE HOSTED DOOR COSTS NO MORE THAN THE FIGURE ON THE BUTTON. The window's
 * own transport, through this engine's real relay, to an account served by the real service: the
 * service stops a run at the confirmed figure (`over_quote`), but only if the figure arrives, and
 * the desktop's door used to leave it out — a set that grew dearer between the quote and the press
 * was bought in full. Only the native shell and the hosted account's HTTP edge stand in.
 */

const OWN = "me@ohmail.test";
const SENDERS = ["a@example.test", "b@example.test", "c@example.test", "d@example.test"];
/** One suggestion's price, read off the program's card rather than restated here. */
const PRICE = PLANE_PRICES.screener!;

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
afterEach(async () => {
  delete host.__TAURI_INTERNALS__;
  await tearDown({ stop: [sidecars], remove: dirs });
});

const send = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** A model that answers every sender, so a short run is the ceiling's doing and never the model's. */
class Yes implements ClassifierPort {
  calls = 0;
  async classify(_input: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    return { destination: "INBOX", confidence: 0.9, spam: false, rationale: "a person writing to you" };
  }
}

/** What reached the account: the purchase body as the engine forwarded it, and its key. */
interface Reached { body: { senders?: unknown; maxCredits?: unknown }; key: string | null }

/**
 * The hosted account's HTTP edge: what the engine's mirror reads to come online, and the purchase
 * route handed to the service the way the route hands it — the parsed body, whole.
 */
function account(mailboxId: string, svc: ScreenerService, ctx: ServiceContext, reached: Reached[]): typeof fetch {
  const none = { creates: [], updates: [], moves: [], deletes: [] };
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/consent") return send({ dormancyDays: 90, autoSuggestAt: CONSENT_AT.toISOString() });
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(mailboxId, OWN)]));
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/sync") return send({ changes: none, cursor: "end", hasMore: false, serverTime: new Date().toISOString() });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/screener/suggest" && init?.method === "POST") {
      const body = JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)) as Reached["body"];
      reached.push({ body, key: new Headers(init.headers).get("idempotency-key") });
      return send(await svc.suggest(ctx, body, { idempotency: null }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/** The native shell, doing what it does and no more: address the engine, add its token, frame the answer. */
function shellAround(sidecar: CloudSidecar): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const method = String(payload?.method ?? "GET").toUpperCase();
      const headers = new Headers();
      for (const [name, value] of (payload?.headers as Array<[string, string]>) ?? []) {
        if (name.toLowerCase() !== "authorization") headers.append(name, value);
      }
      headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
      const body = Uint8Array.from((payload?.body as number[]) ?? []);
      const res = await sidecar.handle(new Request(`http://sidecar${String(payload?.url ?? "")}`, {
        method, headers, ...(body.byteLength > 0 && method !== "GET" ? { body } : {}),
      }));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const meta = new TextEncoder().encode(JSON.stringify({ status: res.status, statusText: res.statusText, h: [...res.headers] }));
      const out = new Uint8Array(4 + meta.byteLength + bytes.byteLength);
      new DataView(out.buffer).setUint32(0, meta.byteLength, false);
      out.set(meta, 4);
      out.set(bytes, 4 + meta.byteLength);
      return out;
    },
  };
}

/**
 * An account holding four waiting senders, behind a signed-in hosted door that is online. Metered
 * by default; `metered: false` is a server that charges nothing, which quotes 0.
 */
const CONSENT_AT = new Date("2026-07-01T00:00:00Z");

async function hostedDoor({ metered = true }: { metered?: boolean } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "hosted-ceiling" });
  await db.insert(accountSettings).values({ accountId, autoSuggestAt: CONSENT_AT });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: OWN }).returning();
  for (const from of SENDERS) await seedMessage(db, accountId, mb!.id, { from });
  const model = new Yes();
  const gate = fakeSpendPort();
  const svc = new ScreenerService(metered
    ? { adapter: new FakeAdapter(), classifier: model, credits: gate, pricing: PLANE_PRICING }
    : { adapter: new FakeAdapter(), classifier: model });
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => new Date("2026-07-28T12:00:00Z"), requestId: "hc" };
  const reached: Reached[] = [];
  const dir = await freshDataDir("ohmail-hosted-ceiling-");
  dirs.push(dir);
  const sidecar = await createCloudSidecar({
    dataDir: dir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl: account(mb!.id, svc, ctx, reached), pollIntervalMs: 3_600_000,
  });
  sidecars.push(sidecar);
  await sidecar.start();
  for (let i = 0; i < 200 && !sidecar.online(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(sidecar.online(), "the hosted door never came online, so no purchase could be relayed").toBe(true);
  shellAround(sidecar);
  const { relaySuggestionGrant: relayGrant } = await consentOverBridge.state();
  return { model, gate, reached, relayGrant: relayGrant ?? null };
}

describe("a confirmed purchase on the hosted door, end to end", () => {
  it("THE CONTROL: a confirm carrying no figure buys the whole set", { timeout: 30_000 }, async () => {
    // Every refusal below is evidence only beside a run this chain DOES admit.
    const { model, gate, reached, relayGrant } = await hostedDoor();
    const res = await cloudSuggestWire.suggest(SENDERS, { relayGrant, idempotencyKey: "k-0" });
    expect(res.charged).toBe(SENDERS.length * PRICE);
    expect(res.suggestions).toHaveLength(SENDERS.length);
    expect(model.calls).toBe(SENDERS.length);
    expect(gate.spends).toHaveLength(SENDERS.length);
    expect(reached.map((r) => r.key)).toEqual(["k-0"]);
  });

  it("over the quote: the sender past the figure is refused, and nothing past it is charged", { timeout: 30_000 }, async () => {
    const { model, gate, reached, relayGrant } = await hostedDoor();
    const shown = (SENDERS.length - 1) * PRICE;
    const res = await cloudSuggestWire.suggest(SENDERS, { relayGrant, idempotencyKey: "k-1", maxCredits: shown });
    expect(reached.map((r) => r.body.maxCredits), "the account was never told the figure").toEqual([shown]);
    expect(res.charged, "the run cost more than the figure on the button").toBe(shown);
    expect(res.stopped).toBe("over_quote");
    expect(res.skipped).toEqual([{ sender: SENDERS[3], reason: "over_quote" }]);
    expect(model.calls, "a sender nobody paid for was sent to the model").toBe(SENDERS.length - 1);
    expect(gate.spends).toHaveLength(SENDERS.length - 1);
  });

  it("a figure the set no longer fits at all: refused whole, nothing charged", { timeout: 30_000 }, async () => {
    // Zero is a real ceiling — a quote of nothing, confirmed — and never "no figure".
    const { model, gate, relayGrant } = await hostedDoor();
    const res = await cloudSuggestWire.suggest(SENDERS, { relayGrant, idempotencyKey: "k-2", maxCredits: 0 });
    expect(res.charged).toBe(0);
    expect(res.stopped).toBe("over_quote");
    expect(res.skipped.map((s) => s.reason)).toEqual(SENDERS.map(() => "over_quote"));
    expect(res.suggestions).toEqual([]);
    expect(model.calls).toBe(0);
    expect(gate.spends, "the account was asked to charge for a refused run").toEqual([]);
  });

  it("a server that charges nothing quotes 0, and that confirmed 0 still buys the whole set", { timeout: 30_000 }, async () => {
    // The door now sends the figure to every server it reaches; where nothing is metered the
    // figure is the server's own 0, and it must bound nothing.
    const { model, reached, relayGrant } = await hostedDoor({ metered: false });
    const quote = await cloudSuggestWire.suggest(SENDERS, { relayGrant, dryRun: true });
    expect(quote.quotedCredits).toBe(0);
    const res = await cloudSuggestWire.suggest(SENDERS, { relayGrant, idempotencyKey: "k-3", maxCredits: quote.quotedCredits });
    expect(reached.map((r) => r.body.maxCredits)).toEqual([undefined, 0]);
    expect(res.suggestions).toHaveLength(SENDERS.length);
    expect(res.stopped).toBeUndefined();
    expect(res.skipped).toEqual([]);
    expect(model.calls).toBe(SENDERS.length);
  });
});
