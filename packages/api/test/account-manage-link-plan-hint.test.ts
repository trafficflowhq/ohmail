import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import type { AccessVerdict, EntitlementsPort, PlanHint } from "@trafficflow/db";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * `POST /account/manage-link` CARRIES THE PLAN CHOSEN ON THE SITE. A signup that started from a tier
 * button names `plan` and `interval`; each reaches the port only as a member of its closed set, and
 * nothing else in the body does. It is a hint for the page's preselection: the port is never handed a
 * price, and Checkout prices what the person submits on that page.
 */

function recordingPort(verdict: AccessVerdict): {
  port: EntitlementsPort;
  asked: Array<{ lang: string | undefined; hint: PlanHint | undefined }>;
} {
  const asked: Array<{ lang: string | undefined; hint: PlanHint | undefined }> = [];
  const access = async (): Promise<AccessVerdict> => verdict;
  return {
    asked,
    port: {
      access,
      accessOrFault: access,
      spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
      release: async () => "settled" as const,
      manageLink: async (_accountId, lang, hint) => {
        asked.push({ lang, hint });
        return { url: "https://plane.ohmail.app/manage?token=t" };
      },
      releaseAccount: async () => "none",
    },
  };
}

const OPEN: AccessVerdict = {
  ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true },
};

async function setup(verdict: AccessVerdict = OPEN) {
  const made = await makeDeps();
  const { port, asked } = recordingPort(verdict);
  const deps = { ...made.deps, services: { ...made.deps.services, entitlementsPort: port } } as ApiDeps;
  const s = await seedSession(made.db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const mint = (body: unknown): Promise<Response> =>
    H(req("POST", "/account/manage-link", { bearer: s.token, body: JSON.stringify(body) }), deps);
  return { mint, asked };
}

describe("POST /account/manage-link forwards the site's plan as a hint", () => {
  it("members reach the port with the language, each half on its own", async () => {
    const { mint, asked } = await setup();
    expect((await mint({ lang: "de", plan: "pro", interval: "year" })).status).toBe(200);
    expect((await mint({ plan: "solo" })).status).toBe(200);
    expect((await mint({ lang: "en", interval: "month" })).status).toBe(200);
    expect(asked).toEqual([
      { lang: "de", hint: { plan: "pro", interval: "year" } },
      { lang: undefined, hint: { plan: "solo" } },
      { lang: "en", hint: { interval: "month" } },
    ]);
  });

  it("a word outside the sets, another case, a number or an array is no hint", async () => {
    // The positive control above is what makes these mean something.
    const { mint, asked } = await setup();
    for (const body of [
      { plan: "enterprise", interval: "week" }, { plan: "Pro", interval: "YEAR" }, { plan: 2, interval: 12 },
      { plan: ["pro"], interval: ["year"] }, { plan: null, interval: null },
    ]) {
      expect((await mint(body)).status, JSON.stringify(body)).toBe(200);
    }
    expect(asked.map((a) => a.hint)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("a price, a price id or an amount in the body never reaches the port", async () => {
    const { mint, asked } = await setup();
    expect((await mint({ plan: "plus", interval: "year", price: 1, priceId: "price_x", amount: 0 })).status).toBe(200);
    expect(asked).toEqual([{ lang: undefined, hint: { plan: "plus", interval: "year" } }]);
    expect(Object.keys(asked[0]!.hint!).sort()).toEqual(["interval", "plan"]);
  });

  it("a REFUSED account still reaches the door with its hint — a first trial starts there", async () => {
    const { mint, asked } = await setup({ ok: false, reason: "payment_required" });
    expect((await mint({ lang: "de", plan: "pro", interval: "year" })).status).toBe(200);
    expect(asked).toEqual([{ lang: "de", hint: { plan: "pro", interval: "year" } }]);
  });
});
