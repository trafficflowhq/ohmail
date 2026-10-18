import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, messages } from "@trafficflow/db";
import type { ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { ScreenerService } from "../src/index.js";
import { materializeMessages } from "../src/dto/materialize.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * AN EXACT-DOMAIN BRAND SENDER IS SHOWN AS UNCONFIRMED UNTIL ITS PROVIDER CONFIRMS IT. A `From` at
 * the brand's own domain is owned by construction, and where the mailbox's provider vouches for
 * nothing (`unavailable`, or NULL: nobody asked) a forgery of that exact domain reads exactly like
 * the brand's own mail. Derived at read time from the two columns on the row; nothing is stored. A
 * claim (`impersonation`) still outranks it, and a confirmed sender (`pass`) shows nothing, as before.
 */

type Seed = { from: string; fromName?: string | null; verdict: string | null; check: "none" | "impersonation" | null; brand?: string };

async function projected(rows: Seed[]) {
  const c = await makeCtx();
  const ids: string[] = [];
  for (const r of rows) {
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, {
      from: r.from, fromName: r.fromName ?? null, authVerdict: r.verdict, folder: "INBOX",
    });
    await c.db.update(messages).set({ senderCheck: r.check, senderCheckBrand: r.brand ?? null }).where(eq(messages.id, id));
    ids.push(id);
  }
  const got = await materializeMessages(c.db, c.accountId, ids);
  return ids.map((id) => got.get(id)!);
}

describe("MessageDTO.senderCheck for a sender at a brand's own domain", () => {
  it("unavailable reads unverified; NULL reads unverified too; pass reads the clean null it always did", async () => {
    const [unavailable, nobody, confirmed] = await projected([
      { from: "service@paypal.com", verdict: "unavailable", check: "none" },
      { from: "service@mail.paypal.com", verdict: null, check: "none" },
      { from: "service@paypal.com", verdict: "pass", check: "none" },
    ]);
    expect(unavailable!.senderCheck).toEqual({ reason: "unverified", brand: "PayPal", domainShared: false });
    expect(nobody!.senderCheck).toEqual({ reason: "unverified", brand: "PayPal", domainShared: false });
    expect(confirmed!.senderCheck).toBeNull();
  });

  it("a row whose identity column was never written says so, so a press reads it as unchecked", async () => {
    const [unchecked] = await projected([{ from: "service@paypal.com", verdict: "unavailable", check: null }]);
    expect(unchecked!.senderCheck).toEqual({ reason: "unverified", brand: "PayPal", domainShared: false, unchecked: true });
  });

  it("a claim outranks it: a brand's address whose name claims another brand is the claim", async () => {
    const [claim] = await projected([
      { from: "service@paypal.com", fromName: "PostFinance", verdict: "unavailable", check: "impersonation", brand: "PostFinance" },
    ]);
    expect(claim!.senderCheck).toMatchObject({ reason: "impersonation", brand: "PostFinance" });
  });

  it("CONTROL: a sender at no brand's domain projects exactly as before, whatever the verdict", async () => {
    const [clean, never] = await projected([
      { from: "anna@studio-nord.example", verdict: "unavailable", check: "none" },
      { from: "anna@studio-nord.example", verdict: null, check: null },
    ]);
    expect(clean!.senderCheck).toBeNull();
    expect("senderCheck" in never!).toBe(false);
  });

  it("a shared provider's address owns no brand, so it is never shown as one", async () => {
    const [shared] = await projected([{ from: personalAt("fixture.nadja", "outlook.com"), verdict: "unavailable", check: "none" }]);
    expect(shared!.senderCheck).toBeNull();
  });

  /* A GOVERNMENT'S UMBRELLA DOMAIN names no one office: every Swiss federal office sends from a host
     under `admin.ch` and the first dictionary row listing it is ESTV's, so naming a row put ESTV on a
     BAG letter. The line names the domain; a confirmed letter still says nothing. */
  it("an umbrella domain's letter names the domain, never the first office listed under it", async () => {
    const [bag, bazg, zas, bsi, never, confirmed, bzst] = await projected([
      { from: "info@bag.admin.ch", verdict: "unavailable", check: "none" },
      { from: "noreply@bazg.admin.ch", verdict: "unavailable", check: "none" },
      { from: "info@zas.admin.ch", verdict: "unavailable", check: "none" },
      { from: "poststelle@bsi.bund.de", verdict: "unavailable", check: "none" },
      { from: "info@bag.admin.ch", verdict: null, check: "none" },
      { from: "info@bag.admin.ch", verdict: "pass", check: "none" },
      // CONTROL: the office's own non-umbrella domain still names it.
      { from: "info@bzst.de", verdict: "unavailable", check: "none" },
    ]);
    for (const dto of [bag, bazg, zas, never]) {
      expect(dto!.senderCheck, dto!.from.address).toEqual({ reason: "unverified", brand: "admin.ch", domainShared: false });
    }
    expect(bsi!.senderCheck).toEqual({ reason: "unverified", brand: "bund.de", domainShared: false });
    expect(confirmed!.senderCheck).toBeNull();
    expect(bzst!.senderCheck).toEqual({ reason: "unverified", brand: "Bundeszentralamt für Steuern", domainShared: false });
  });
});

describe("the Screener row's `checked` for a waiting brand sender", () => {
  const READS: ClassifierResult = { destination: "ohmail/News", confidence: 0.95, spam: false, rationale: "a notice" };
  const classifier: ClassifierPort = { classify: async () => READS };

  async function listed(seeds: Array<{ from: string; verdict: string | null; fromName?: string }>) {
    const w = await makeCtx(new Date("2026-07-28T12:00:00Z"));
    await w.db.insert(accounts).values({ id: w.accountId, name: "screener" });
    for (const s of seeds) {
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: s.from, fromName: s.fromName ?? null, authVerdict: s.verdict });
    }
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier, pricing: PLANE_PRICING,
      credits: fakeSpendPort({ verdict: "ok", charged: true, attempt: "1" }),
    });
    const page = await svc.list(w.ctx, {});
    return new Map(page.items.map((i) => [i.sender.address, i]));
  }

  it("an unconfirmed brand sender is said to be unconfirmed; the confirmed one is not; a claim stays a claim", async () => {
    const byS = await listed([
      { from: "service@paypal.com", verdict: "unavailable" },
      { from: "receipts@post.ch", verdict: "pass" },
      { from: "kundendienst@karten-service.example", verdict: "unavailable", fromName: "PostFinance" },
    ]);
    expect(byS.get("service@paypal.com")!.checked).toEqual({ reason: "unverified", brand: "PayPal", domainShared: false });
    expect(byS.get("receipts@post.ch")!.checked).toBeUndefined();
    expect(byS.get("kundendienst@karten-service.example")!.checked).toMatchObject({ reason: "impersonation", brand: "PostFinance" });
  });

  it("a waiting federal office at an umbrella domain is said to be unconfirmed under the domain's name", async () => {
    const byS = await listed([
      { from: "info@bag.admin.ch", verdict: "unavailable", fromName: "Bundesamt für Gesundheit BAG" },
      { from: "poststelle@bsi.bund.de", verdict: null },
      { from: "info@zas.admin.ch", verdict: "pass" },
    ]);
    expect(byS.get("info@bag.admin.ch")!.checked).toEqual({ reason: "unverified", brand: "admin.ch", domainShared: false });
    expect(byS.get("poststelle@bsi.bund.de")!.checked).toEqual({ reason: "unverified", brand: "bund.de", domainShared: false });
    expect(byS.get("info@zas.admin.ch")!.checked).toBeUndefined();
  });
});
