/** @vitest-environment node */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DRAFT_REPLY_COST_CREDITS } from "../app/shell/draft-reply";

/**
 * ═══ AI DRAFTING IS SHIPPED, WIRED AND REACHABLE — pinned, because a claim now rests on it ═══
 *
 * The trial copy says a trial "comes with 500 AI actions, so **the drafts** and the Screener's
 * suggestions are yours to try" (`messages/en.json` — `terms`, `trialNote`, the `a7` FAQ). That
 * sentence is only true if an "action" is one price. It is not: the metering program's card prices a
 * classification at one price and a draft at a far higher one, so the same credits buy many screener decisions OR a few drafts.
 *
 * It was proposed that the sentence is nevertheless true because **drafting is disabled** — with
 * only classification purchasable, 500 credits really is 500 screener actions. That premise is
 * the whole of the claim's truth, so it is checked here rather than remembered, and **at the time
 * this file was written it was false in four places at once.** Each `it` below is one of them.
 *
 * This file does NOT assert that the copy is wrong; copy is a product decision. It asserts the four
 * mechanical facts the copy's truth depends on, so that "drafting is off" can never again be
 * adopted as a premise without a test going red first.
 *
 * ── WHY SOURCE TEXT AND NOT AN IMPORT ────────────────────────────────────────────────────────
 *
 * Three of the four facts live outside this app — the API route table, the Vercel composition
 * root and the weight schedule — and this is a browser bundle that must not pull the server
 * graph in. The same census shape `sign-out-clears-durable-stores.test.ts` uses, for the same
 * reason. `DRAFT_REPLY_COST_CREDITS` is this app's own and is imported.
 *
 * ── THE MUTATIONS EACH CASE WAS WATCHED AGAINST ──────────────────────────────────────────────
 *
 *  · remove the `draft` item from the ⋯ menu                → "a reader can ask for one" red;
 *  · make `case "draft"` navigate to Compose again (what it did before it was connected)
 *                                                            → "the verb reaches the drafter" red;
 *  · drop `cost: "paid"` from the route                      → "the route is metered" red;
 *  · wrap the drafter wiring in `if (false)`                 → "production wires one" red;
 *  · set `debit_draft: 1` in the schedule                    → "the prices differ" red, which is
 *    the one mutation that would make the copy TRUE — and it is a pricing decision, not a test
 *    fix.
 */

import { shellSliceOf } from "./source-anchor";

const ROOT = existsSync(resolve("apps/webapp/app")) ? resolve(".") : resolve("../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

describe("the premise that drafting is disabled, checked in the four places it would have to be", () => {
  it("a reader can ask for a drafted reply — the verb is in the message menu", () => {
    const pane = read("apps/webapp/app/shell/MessagePane.tsx");
    expect(
      /id:\s*"draft"/.test(pane) && /onAction\("draft"\)/.test(pane),
      "the ⋯ menu no longer offers Draft reply",
    ).toBe(true);
  });

  it("the verb reaches the drafter rather than opening an empty compose", () => {
    // What it used to do — `setReaderFor(null); go("compose")` — is the shape of a feature that
    // was planned and not connected. It is connected.
    /* The message verbs moved to `shell-verbs.ts` at ARCH-022; the arm is read inside
       `onMessageAction`'s own declaration, from whichever frame the manifest says holds it. */
    const arm = shellSliceOf("onMessageAction");
    expect(/case "draft":[\s\S]{0,1600}?draftReply\.open\(/.test(arm)).toBe(true);
    expect(read("apps/webapp/app/shell/draft-reply.ts")).toContain("/messages/${id}/draft");
  });

  it("the route exists, is classed as a paid model call, and is metered", () => {
    const routes = read("packages/api/src/routes/messages.ts");
    expect(routes).toContain('pattern: "/messages/:id/draft"');
    // `cost: "paid"` is the class that says this spends. It is asserted on the draft route
    // specifically, not anywhere in the file.
    expect(
      /pattern:\s*"\/messages\/:id\/draft"[\s\S]{0,2000}?cost:\s*"paid"/.test(routes),
      "the draft route is no longer classed as a paid model call",
    ).toBe(true);
    expect(routes).toContain("an Idempotency-Key header is required for AI drafting");
  });

  it("the production API wires a drafter whenever a model key is present — no flag turns it off", () => {
    const deps = read("apps/server/src/deps.ts");
    expect(
      /if \(cfg\.ai !== null\) put\(bag, "drafter"/.test(deps),
      "the managed host no longer arms a drafter, which would change what a credit buys",
    ).toBe(true);
  });

  /* The metering program's card, from the byte copy of its contract example — this tree holds
     no price of its own, so the program's statement is the one to hold these figures to. */
  const card = (): Record<string, number> => {
    const prices = (JSON.parse(read("packages/db/test/fixtures/entitlements-port/access-200-active.json")) as {
      prices?: Record<string, number>;
    }).prices;
    expect(prices, "the price card is no longer in the program's access example").toBeDefined();
    return prices!;
  };

  it("and the prices differ, which is what makes `500 AI actions` ambiguous", () => {
    expect(card().screener).toBe(1);
    expect(card().draft).toBe(DRAFT_REPLY_COST_CREDITS);
    expect(
      card().draft,
      "a flat schedule would make the trial copy true; a weighted one does not",
    ).toBeGreaterThan(card().screener!);
  });

  it("the client's consent sentence quotes the program's own price, not a second copy of it", () => {
    // The client states the cost before spending. If the card is repriced and this constant is
    // not, the sentence a person consents to becomes a lie — which is the same class of defect as
    // the trial copy, one surface further in.
    expect(card().draft).toBe(DRAFT_REPLY_COST_CREDITS);
  });
});
