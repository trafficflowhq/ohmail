import { randomUUID } from "node:crypto";
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accounts, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import type { ClassifierPort, ClassifierResult } from "@trafficflow/core";
import {
  AuthService, ScreenerService, generateToken, hashToken, makeTestAuthDeps, type ServiceContext,
} from "../src/index.js";
import { fakeSpendPort, type FakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";

/**
 * A FAULT A SERVICE SWALLOWS IS NAMED BY CLASS AND CODE, AND NOTHING IT CARRIES REACHES THE DRAIN.
 *
 * Each site below used to `console.error` the thrown value whole. The plant is an address and an
 * opaque token, in the message, a driver-style `detail`, `parameters` and the `cause`: shapes no
 * value scrubber recognises, so only dropping the message can keep them out. Every case also reads
 * its line back (event, class, code, no dropped field), so an absent line cannot pass as a clean one.
 */

const ADDRESS = "planted.person@ex.example";
// Assembled at run time: an opaque value no scrubber knows, kept out of the source as one literal.
const OPAQUE = ["PLANTED", "tok", (0x9f8e7d6c5b4a).toString(16)].join("");

class PlantedFault extends Error {
  readonly code = "08006";
  readonly detail = `Key (endpoint)=(https://push.example/${OPAQUE}) for ${ADDRESS}`;
  readonly parameters = [OPAQUE, ADDRESS];
  constructor() {
    super(`connection for ${ADDRESS} failed: ${OPAQUE}`, { cause: new Error(`tls: ${OPAQUE} ${ADDRESS}`) });
    this.name = "PlantedFault";
  }
}

/** Everything the process would print, as Node renders it, and the logger's own lines. */
function heard() {
  const printed: string[] = [];
  const lines: Array<Record<string, unknown>> = [];
  for (const m of ["error", "warn", "info", "debug", "trace"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { printed.push(format(...a)); });
  }
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    const s = format(...a);
    printed.push(s);
    try { lines.push(JSON.parse(s) as Record<string, unknown>); } catch { /* not a log line */ }
  });
  return { printed: () => printed.join("\n"), named: (event: string) => lines.filter((l) => l.event === event) };
}

function expectClassAndCodeOnly(h: ReturnType<typeof heard>, event: string, want: Record<string, unknown>): void {
  const named = h.named(event);
  expect(named, `${event} was not written exactly once`).toHaveLength(1);
  expect(named[0]).toMatchObject({ event, errorClass: "PlantedFault", errorCode: "08006", causeClass: "Error", ...want });
  expect(named[0], "the census dropped a field the site passes").not.toHaveProperty("droppedFields");
  const out = h.printed();
  expect(out.includes(ADDRESS), "the planted address reached the process output").toBe(false);
  expect(out.includes(OPAQUE), "the planted token reached the process output").toBe(false);
}

afterEach(() => { vi.restoreAllMocks(); });

const NOW = new Date("2026-09-24T12:00:00Z");
const YES: ClassifierResult = { destination: "INBOX", confidence: 0.9, rationale: "a person", spam: false };
const answering: ClassifierPort = { async classify() { return YES; } };

async function world(credits: FakeSpendPort = fakeSpendPort()) {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "swallowed" });
  const alice = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
  return { ...w, credits, alice };
}

describe("control", () => {
  it("the plant is in what Node prints for the thrown value whole", () => {
    expect(format(new PlantedFault()).includes(ADDRESS)).toBe(true);
    expect(format(new PlantedFault()).includes(OPAQUE)).toBe(true);
  });
});

describe("the Screener's suggest path", () => {
  it("a model fault: skipped as model_unavailable, named by class and code", async () => {
    const w = await world();
    const faulting: ClassifierPort = { async classify(): Promise<never> { throw new PlantedFault(); } };
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: faulting, credits: w.credits, pricing: PLANE_PRICING });
    const h = heard();
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_unavailable" }]);
    expectClassAndCodeOnly(h, "screener_suggest_model_failed", {
      level: "warn", service: "screener", accountId: w.accountId, messageId: w.alice, requestId: w.ctx.requestId,
    });
  });

  it("a claim release fault: the suggestion is still served", async () => {
    const w = await world();
    const faulting: FakeSpendPort = {
      ...w.credits,
      release: async (accountId, r) => { await w.credits.release(accountId, r); throw new PlantedFault(); },
    };
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: answering, credits: faulting, pricing: PLANE_PRICING });
    const h = heard();
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(res.suggestions.map((s) => s.sender)).toEqual(["alice@ex.example"]);
    expectClassAndCodeOnly(h, "screener_suggest_release_failed", {
      level: "warn", service: "screener", accountId: w.accountId, messageId: w.alice, requestId: w.ctx.requestId,
    });
  });

  it("a balance read fault: the run answers without a balance", async () => {
    const w = await world();
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: answering, credits: w.credits, pricing: PLANE_PRICING,
      remaining: async () => { throw new PlantedFault(); },
    });
    const h = heard();
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(res.suggestions.map((s) => s.sender)).toEqual(["alice@ex.example"]);
    expect(res).not.toHaveProperty("remainingCredits");
    expectClassAndCodeOnly(h, "screener_suggest_balance_read_failed", {
      level: "warn", service: "screener", accountId: w.accountId, requestId: w.ctx.requestId,
    });
  });

  it("a key release fault: the pass error stands", async () => {
    const w = await world();
    let failTx = false;
    const db = new Proxy(w.db as unknown as object, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (fn: (tx: Tx) => Promise<unknown>) => {
            if (failTx) throw new PlantedFault();
            return (target as { transaction: (f: typeof fn) => Promise<unknown> }).transaction(fn);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof w.db;
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: answering, credits: w.credits, pricing: PLANE_PRICING });
    (svc as unknown as { store: () => Promise<void> }).store = async () => { failTx = true; throw new Error("store fault"); };
    const h = heard();
    const thrown = await svc.suggest({ ...w.ctx, db }, { senders: ["alice@ex.example"] },
      { idempotency: { key: "k-swallowed", requestHash: "hA" } }).then(() => "none", (e: unknown) => (e as Error).message);
    expect(thrown).toBe("store fault");
    expectClassAndCodeOnly(h, "screener_suggest_key_release_failed", {
      level: "warn", service: "screener", accountId: w.accountId, requestId: w.ctx.requestId,
    });
  });
});

describe("the sign-out by refresh token", () => {
  it("a wake prune fault: the sign-out stands, named by class and code", async () => {
    const db = await makeTestDb();
    const t0 = new Date("2026-10-01T10:00:00Z");
    const [acct] = await db.insert(accounts).values({ name: "swallowed" }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `s-${randomUUID()}@lichtgrat.example`, displayName: "S", emailVerifiedAt: t0,
    }).returning();
    const r1 = generateToken();
    const familyId = randomUUID();
    const [sess] = await db.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId, accessTokenHash: hashToken(generateToken()),
      accessExpiresAt: new Date(t0.getTime() + 900_000), refreshExpiresAt: new Date(t0.getTime() + 86_400_000),
      lastSeenAt: t0, createdAt: t0,
    }).returning();
    await db.insert(refreshTokens).values({
      accountId: acct!.id, userId: user!.id, sessionId: sess!.id, familyId, tokenHash: hashToken(r1),
      expiresAt: new Date(t0.getTime() + 86_400_000), createdAt: t0,
    });
    class PruneDown extends AuthService {
      protected override async pruneWakeRegistrations(): Promise<void> { throw new PlantedFault(); }
    }
    const ctx: ServiceContext = { db, accountId: "", userId: null, now: () => new Date(t0.getTime() + 1_000), requestId: "r-signout" };
    const h = heard();
    await expect(new PruneDown(makeTestAuthDeps()).logout(ctx, { refreshToken: r1 })).resolves.toEqual({ familyIds: [familyId] });
    expectClassAndCodeOnly(h, "auth_logout_wake_prune_failed", {
      level: "error", service: "auth", requestId: "r-signout", count: 1,
    });
  });
});
