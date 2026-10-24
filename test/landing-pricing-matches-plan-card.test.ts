import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The metering program's card, from the byte copy of its contract: this tree holds no price.
import { PLANE_PRICES } from "../packages/services/test/helpers/plane-pricing.js";
import { LARGEST_PLAN_STORAGE_BYTES } from "@trafficflow/db";

/**
 * THE PLAN CARD, AS LITERALS — and the change of kind is the whole point.
 *
 * This file used to import `PLAN_LIMITS` from the server, which made the server the authority
 * for what the marketing page may claim. The server no longer holds a plan card: plans, prices
 * and allowances belong to whoever operates the service, and its own suite pins the same figures
 * from its side. So the numbers are written out HERE, and this file's job narrows to the one it
 * can still do honestly: the two catalogues, the two locales and the derived email count all say
 * the SAME thing as each other, so a tier change cannot land in one of them and not the rest.
 *
 * A figure changed on the service side and not here is caught over there, by the test that reads
 * these same numbers from its own definition.
 */
const PLAN_LIMITS = {
  solo: { priceUsd: 9, mailboxes: 2, monthlyCredits: 1_000, storageBytes: 2_000_000_000 },
  plus: { priceUsd: 15, mailboxes: 5, monthlyCredits: 2_000, storageBytes: 5_000_000_000 },
  pro: { priceUsd: 29, mailboxes: 10, monthlyCredits: 4_000, storageBytes: 10_000_000_000 },
} as const;

/** The measured bytes-per-stored-email the card's capacity claim divides by. */
const BYTES_PER_STORED_EMAIL_ESTIMATE = 25_000;
const estimatedStoredEmails = (storageBytes: number): number =>
  Math.floor(storageBytes / BYTES_PER_STORED_EMAIL_ESTIMATE);

/**
 * THE ANTI-DRIFT GATE BETWEEN WHAT THE SITE SELLS AND WHAT THE API ENFORCES.
 *
 * This exists because the two came apart exactly once, in the obvious direction: the tier
 * change (task #48, mailboxes 2/5/10 → 5/10/50) was applied to `messages/en.json` and nowhere
 * else, so ohmail.app advertised Solo as five mailboxes while `POST /mailboxes` answered
 * `409 mailbox_limit_reached` on the third. Nothing in the repo could notice — the copy is a
 * string in a JSON file and the limit is a number in `packages/db`, and no test read both.
 *
 * Now one does. Every number the landing page prints for a Cloud tier is parsed back out of the
 * shipped message catalogue and compared to the value the API actually enforces.
 *
 * It lives in the repo-level `test/` directory rather than in either workspace precisely
 * because it belongs to NEITHER: `apps/webapp` does not depend on `@trafficflow/db`, and
 * `packages/db` has no business importing a marketing catalogue. A check with no owner is a
 * check nobody writes — which is why this one did not exist.
 *
 * Deliberately parsed rather than templated: the message must stay a plain human sentence a
 * translator can rewrite ("5 mailboxes" → "5 Postfächer"). What is pinned is the NUMBER, not
 * the phrasing — the regex takes the first integer in the string.
 *
 * ── WHAT THE 2026-08-21 RE-PRICING ADDED TO THIS FILE ──────────────────────────────────────
 *
 * Three new drift surfaces, each of which is a number in copy derived from a number in code:
 *
 *  · **CREDITS, not actions.** The card used to sell an AI-actions allowance against
 *    `monthlyCredits: 2_000`, so the two agreed by being the same unit. Debits are weighted now
 *    (the metering program's card), so an action is a MULTIPLE of a credit and the copy has to sell
 *    the credit. The allowance check is unchanged in form; what is new is the assertion that the
 *    copy no longer promises actions, because an actions figure would now be a 15× overstatement
 *    for anybody who drafts.
 *  · **STORAGE AS AN EMAIL COUNT.** Owner decision: the card says "room for roughly N
 *    emails" rather than "2 GB", because nobody knows how many emails fit in a gigabyte. That
 *    count is `storageBytes / BYTES_PER_STORED_EMAIL_ESTIMATE`, and this file is what stops the
 *    copy and the arithmetic parting company — the exact failure mode the mailbox count already
 *    had once.
 *  · **THE CLIENT'S OWN DRAFT PRICE.** `apps/webapp/app/shell/draft-reply.ts` states the price of
 *    a draft to the person about to buy one, as a literal, because the webapp takes no dependency
 *    on `packages/db`. That literal is read out of the source here and compared to
 *    the program's card price for `draft`.
 */
type Catalogue = Record<"pricing" | "join" | "billing", Record<string, string>>;
const catalogue = (locale: string): Catalogue => JSON.parse(
  readFileSync(fileURLToPath(new URL(`../apps/webapp/messages/${locale}.json`, import.meta.url)), "utf8"),
) as Catalogue;

const TIERS = [
  { plan: "solo", price: "soloPrice", mailboxes: "soloMailboxes", credits: "soloActions", storage: "soloStorage" },
  { plan: "plus", price: "plusPrice", mailboxes: "plusMailboxes", credits: "plusActions", storage: "plusStorage" },
  { plan: "pro", price: "proPrice", mailboxes: "proMailboxes", credits: "proActions", storage: "proStorage" },
] as const;

/** First integer in the string, thousands separators removed: "N AI credits/mo" → N. */
function firstNumber(s: string): number {
  const m = s.replace(/[,.](?=\d{3}\b)/g, "").match(/\d+/);
  expect(m, `no number in ${JSON.stringify(s)}`).not.toBeNull();
  return Number(m![0]);
}

describe("the landing's Cloud tiers are the plan card the API enforces", () => {
  /**
   * EVERY NUMBER ON EVERY CARD, IN EVERY LOCALE — and the second half of that sentence is new.
   *
   * These two cases read one `catalogue("en")` for every assertion, so the German card's price,
   * mailbox count, credit allowance and email count were pinned to nothing at all: the only
   * German assertions in this file were about WORDS (the "rund" hedge, the "Credits"
   * unit). A German card advertising 19 $ against a 9 USD Checkout would have shipped green,
   * which is the identical failure this file was written for — the tier change applied to one
   * catalogue and not the other — surviving in the locale nobody parameterized.
   *
   * It was found the hard way: the annual case below now DERIVES its expectation from the
   * monthly string in the same catalogue, and a review pointed out that deriving from an
   * unchecked string makes the derivation authoritative rather than tested. The derivation is
   * right; the missing locale was the bug under it.
   */
  for (const tier of TIERS) {
    it.each(["en", "de"])(`${tier.plan}: %s — price, mailboxes and credits match PLAN_LIMITS.${tier.plan}`, (locale) => {
      const { pricing } = catalogue(locale);
      const card = PLAN_LIMITS[tier.plan];
      expect(firstNumber(pricing[tier.price]!), `${locale} price`).toBe(card.priceUsd);
      expect(firstNumber(pricing[tier.mailboxes]!), `${locale} mailboxes`).toBe(card.mailboxes);
      expect(firstNumber(pricing[tier.credits]!), `${locale} monthly credits`).toBe(card.monthlyCredits);
    });

    it.each(["en", "de"])(`${tier.plan}: %s — the advertised email count is the byte cap over the measured estimate`, (locale) => {
      const { pricing } = catalogue(locale);
      const card = PLAN_LIMITS[tier.plan];
      // Storage is SOLD as a count and ENFORCED in bytes. This is the whole join between the two,
      // and it is derived rather than typed: change the cap, the estimate or the sentence, and
      // exactly one of the three sides moves — which is what this catches.
      expect(firstNumber(pricing[tier.storage]!), `${locale} stored emails`)
        .toBe(estimatedStoredEmails(card.storageBytes));
    });
  }

  it("covers every plan on the card — a new tier cannot ship unchecked", () => {
    expect(TIERS.map((t) => t.plan).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());
  });

  it("the estimate is the measured one, rounded AGAINST us", () => {
    // Measured on a real heavy account: its stored bytes over its stored messages.
    // The constant must be at least that, because a LARGER assumed email advertises FEWER of
    // them — the only direction a capacity claim may be wrong in. A constant below the
    // measurement would over-promise, which is the failure this case exists to refuse.
    const MEASURED = 1_720_000_000 / 73_167;
    expect(BYTES_PER_STORED_EMAIL_ESTIMATE).toBeGreaterThanOrEqual(MEASURED);
    // …and not so far above it that the card becomes silly: within a fixed margin of what was measured.
    expect(BYTES_PER_STORED_EMAIL_ESTIMATE).toBeLessThan(MEASURED * 1.5);
    expect(estimatedStoredEmails(PLAN_LIMITS.solo.storageBytes)).toBe(80_000);
    expect(estimatedStoredEmails(PLAN_LIMITS.plus.storageBytes)).toBe(200_000);
    expect(estimatedStoredEmails(PLAN_LIMITS.pro.storageBytes)).toBe(400_000);
  });

  /**
   * The counts are an ESTIMATE and the copy has to say so, in both locales. This is not a style
   * rule: an average over one heavy mailbox is not a promise about any particular mailbox, and a
   * newsletter-heavy account will store fewer and larger bodies than the average. Drop the
   * hedge and the sentence becomes a capacity guarantee the product cannot keep.
   */
  it.each([["en", /roughly/i], ["de", /rund/i]])(
    "%s: the email counts read as estimates, and the attachment fact travels with them",
    (locale, hedge) => {
      const { pricing } = catalogue(locale);
      for (const tier of TIERS) {
        expect(pricing[tier.storage], `${locale} ${tier.storage}`).toMatch(hedge);
      }
      // Attachments never counting is a STRUCTURAL fact — attachment bytes are never stored
      // server-side, only their metadata — which is exactly why the copy is entitled to say it,
      // and why it must keep saying it: it is the differentiator that makes the count credible.
      const attach = locale === "en" ? /attachments stay in your mailbox/i : /Anhänge bleiben in deinem Postfach/i;
      expect(pricing.storageNote, `${locale} storageNote`).toMatch(attach);
      expect(pricing.storageNote, `${locale} storageNote`).toMatch(/25 KB/);
    },
  );

  /**
   * THE UNIT MOVED FROM ACTIONS TO CREDITS, and the old word must not survive on the card.
   *
   * An actions figure would be a 15× overstatement for anyone who drafts — the allowance buys
   * many classifications or a few drafts, and only the credit figure is true of both. This is the
   * "claims are contracts" rule applied to the one number the site prints that the ledger charges.
   */
  it.each([["en", /credits/i], ["de", /\bCredits\b/]])(
    "%s: the allowance is sold in credits, never as a flat action count",
    (locale, unit) => {
      const { pricing } = catalogue(locale);
      for (const tier of TIERS) {
        expect(pricing[tier.credits], `${locale} ${tier.credits}`).toMatch(unit);
        expect(pricing[tier.credits], `${locale} ${tier.credits}`).not.toMatch(/AI actions|KI-Aktionen|KI-Einheiten/i);
      }
    },
  );

  /**
   * THE CLIENT'S DRAFT PRICE, read out of the source rather than imported.
   *
   * `apps/webapp` deliberately does not depend on `@trafficflow/db` (`connect-gate-order.test.ts`
   * asserts its source never even names `PLAN_LIMITS`), so the price a person is quoted before
   * pressing "Draft reply" is a literal in the webapp. That is a drift surface of exactly the kind
   * this file exists for, so it is closed the same way: parse the literal, compare it to the weight
   * the gate actually debits.
   */
  it("the webapp quotes the price the gate charges for a draft", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../apps/webapp/app/shell/draft-reply.ts", import.meta.url)), "utf8");
    const m = src.match(/export const DRAFT_REPLY_COST_CREDITS = (\d+);/);
    expect(m, "DRAFT_REPLY_COST_CREDITS is not declared as a plain integer literal").not.toBeNull();
    expect(Number(m![1])).toBe(PLANE_PRICES.draft);
  });

  /**
   * The offer sheet states that price in words, and takes the NUMBER from the constant above: the
   * sentence interpolates `{cost}` (the card passes `DRAFT_REPLY_COST_CREDITS`) and carries no
   * figure of its own, so the two cannot disagree. The unmetered twin states no price at all.
   */
  it.each(["en", "de"])("%s: the draft offer names the draft's price from the one constant", (locale) => {
    const all = JSON.parse(readFileSync(
      fileURLToPath(new URL(`../apps/webapp/messages/${locale}.json`, import.meta.url)), "utf8"),
    ) as { draftReply: Record<string, string> };
    expect(all.draftReply.offerBody).toMatch(/\{cost, plural,/);
    expect(all.draftReply.offerBody.replace(/\{[^{}]*\{[^{}]*\}[^{}]*\{[^{}]*\}\}/g, "")).not.toMatch(/\d/);
    expect(all.draftReply.offerBodyUnmetered).not.toMatch(/\d|credit|Punkt|budget/i);
    // "one unit of your AI budget" was true under a flat credit and is now false by 15×.
    expect(all.draftReply.offerBody).not.toMatch(/one unit|eine Einheit/i);
  });

  /**
   * THE ANNUAL PRICES ARE THE MONTHLY CARD × 10 — "two months free", as arithmetic — AND THEY
   * CARRY THE SAME CURRENCY ORDER AS THE MONTHLY STRING BESIDE THEM.
   *
   * The Stripe annual prices carry the same figures; a card change that forgot the annual keys
   * would sell a year at last year's price, in copy, next to a Checkout that charges this year's.
   *
   * THE ORDER HALF IS NEW, AND THIS CASE IS THE REASON IT HAD TO BE. It asserted
   * `` `$${priceUsd * 10}` `` for BOTH locales, so the guard itself demanded the English order in
   * the German catalogue — and got it: "9 $" for the month next to "$90" for the year, one card,
   * two conventions, the dollar sign jumping across the figure as the toggle moved. A guard
   * pinned to the wrong side of an invariant is worse than no guard, because it defends the
   * defect against the person who notices it.
   *
   * So the expectation is DERIVED from that locale's own monthly string instead of written out
   * once per locale: whatever side of the figure a catalogue puts the "$" on for a month, it puts
   * it on the same side for a year. Both directions are pinned per locale now — Anglicize the
   * German annual string and this fails; Germanize the English one and it fails too — and this
   * file still holds no opinion about where any particular language belongs its currency, which
   * is exactly the opinion it got wrong.
   */
  it.each(["en", "de"])("%s: the annual price strings are ten monthly months, in that locale's currency order", (locale) => {
    const { pricing } = catalogue(locale);
    for (const tier of TIERS) {
      const monthly = pricing[`${tier.plan}Price`]!;
      const price = PLAN_LIMITS[tier.plan].priceUsd;
      /* THE STRING BEING DERIVED FROM IS PINNED FIRST, in this locale, or the derivation would
         make the catalogue its own authority: a German "19 $" would yield "190 $" and this case
         would certify both against a Checkout that charges 9. The per-tier cases above pin the
         amount in every locale; these two lines are the local restatement of what this
         particular derivation depends on — the amount, and the presence of a currency token at
         all, without which an order rule is a rule about nothing. */
      expect(firstNumber(monthly), `${locale} ${tier.plan}Price`).toBe(price);
      expect(monthly, `${locale} ${tier.plan}Price carries no currency symbol`).toContain("$");
      // The monthly string with its figure swapped for ten of them: "$9" → "$90", "9 $" → "90 $".
      // `\b` so the WHOLE figure moves: a substring replace turns "19" into "190" and calls it
      // ten months. The figure is `PLAN_LIMITS`'; only the punctuation around it is the
      // catalogue's, which is the whole point of deriving instead of writing it out per locale.
      const expected = monthly.replace(new RegExp(`\\b${price}\\b`), String(price * 10));
      expect(expected, `${locale} ${tier.plan}Price does not contain its own figure`).not.toBe(monthly);
      expect(pricing[`${tier.plan}PriceAnnual`], `${locale} ${tier.plan}PriceAnnual`).toBe(expected);
    }
    // The toggle exists in copy — a monthly-only page must fail here, not ship quietly.
    expect(pricing.intervalMonthly).toBeTruthy();
    expect(pricing.intervalAnnual).toBeTruthy();
    expect(pricing.perYear).toBeTruthy();
  });

  /**
   * THE SAME ORDER RULE ON THE PRICE TEMPLATES THE PRODUCT ITSELF RENDERS.
   *
   * RETIRED, and the reason is worth keeping: it compared every PRICE TEMPLATE in the product
   * against its locale's monthly one, because the German catalogue had split — "{price} $/Monat"
   * for the plan next to "${price}/Jahr" for the annual toggle. No product surface interpolates
   * a price any more. The subscription pane's three templates and the signup funnel's two left
   * with the plan cards; what remains is the marketing card's flat strings, and the cases above
   * hold those against `PLAN_LIMITS` directly.
   *
   * Deleted rather than kept as a case over an empty list: a sweep with nothing to sweep passes
   * for the wrong reason, and the census below already refuses a price appearing anywhere it
   * should not.
   */

  /**
   * THE CLIENTS' EMAIL-COUNT ESTIMATE, read out of the source exactly like the draft price
   * above and for the same reason: the client tree cannot import `@trafficflow/db`, so the
   * shared derivation restates `BYTES_PER_STORED_EMAIL_ESTIMATE` as a literal. Two literals,
   * one measured fact — this is the comparison that keeps them one.
   *
   * ONE literal, not one per client: `storage-state.ts` sits in `app/shell`, the directory both
   * the browser tab and the desktop app compile, and both storage rows read it. A second copy
   * beside a second pane would be a second thing for this case to have to know about.
   */
  /**
   * ═══ WHAT THE STORED EMAILS ARE STORED *FOR* — the scope of the capacity claim ═══════════
   *
   * "room for roughly N emails" was true and unscoped, and unscoped is the whole problem:
   * ohmail's pitch is that the IMAP mailbox is the master and stays the person's own, so a bare
   * capacity figure on a pricing card reads as a cap on THEIR MAIL. It is not. It is the cap on
   * the message content the hosted web app keeps a copy of so a browser and a second device can
   * read it; a mailbox on somebody's own server is not measured, not counted, and not affected
   * when the figure is reached (`webStorageFull` says so, and the desktop app stores nothing on
   * ohmail's servers at all — `pointByo`).
   *
   * The subscription pane stated that correctly for releases while the landing card, which is
   * where the number is SOLD, did not. The card carries both facts now, and this is the case
   * that keeps them on it:
   *
   *   · the scope — the WEB APP is what stores it;
   *   · the exclusion — the mailbox on your own server is never counted.
   *
   * Both are asserted on all three cards, in each locale's own words. What is written out here
   * per locale is a TOKEN, not a sentence: German inflects and reorders, so deriving the card's
   * phrasing from another surface's would pin German to English word order — the mistake the
   * annual-price case above documents making, in the same file. A token per locale holds the
   * fact without holding the grammar.
   *
   * The subscription pane used to be the second surface here and be read FIRST, so that a guard
   * reading only the card could not certify it against nothing. That pane has left the tree, so
   * the tokens below are the pin: they are what the card is held to, and changing one is a
   * deliberate edit to this file rather than a side effect of editing a pane.
   */
  it.each([
    ["en", /for the web app/i, /never counted/i],
    ["de", /für die Web-App/i, /nie mitgezählt/i],
  ])("%s: the card scopes its capacity claim to the web app and excludes your own server", (locale, scope, exclusion) => {
    const { pricing } = catalogue(locale);
    for (const tier of TIERS) {
      const line = pricing[tier.storage]!;
      expect(line, `${locale} ${tier.storage} does not say what the room is for`).toMatch(scope);
      expect(line, `${locale} ${tier.storage} drops the own-server exclusion`).toMatch(exclusion);
    }
  });

  /**
   * ═══ NOTHING COUNTS CREDITS IN "AI ACTIONS" — a census over both catalogues ═══════════════
   *
   * The per-tier case above refuses the flat-action unit on the three CARD keys, and that narrow
   * scope was the defect: the same overstatement was live in six other places, five of them on
   * the very page the card sits on and one of them in the product.
   *
   *   pricing.trialNote · trial.terms · faq.a7   "500 AI actions"
   *   join.planSub                               "~{credits} AI actions a month"  ← monthlyCredits
   *   join.trialNote                             "{credits} AI actions"           ← trialCredits
   *   aiCredits.trialLeft                        "{count} AI actions left"        ← ledger balance
   *
   * Every one of those numbers is a CREDIT balance. An action costs 1 to 20 of them
   * (the metering program's card), so "500 AI actions" promised up to twenty times what 500 credits
   * buys — to somebody the same sentence was inviting to try the DRAFTS, which are the expensive
   * end of the schedule. Four rows below the last of them, `faq.a4` explained the real rate.
   *
   * ── WHAT THE CENSUS DOES AND DOES NOT REFUSE ──────────────────────────────────────────────
   *
   * It fires only where a FIGURE meets the unit: a digit, a `#`, or the close of a placeholder
   * immediately before "AI action(s)" / "KI-Aktion(en)". That boundary is deliberate, not a
   * convenience. "AI action" is a real thing and the product may name it — `aiCredits.noPlan`
   * ("AI actions come with a plan"), `aiCredits.trialSpent`, `settings.aiLabel` ("Managed AI
   * actions") and `ai.status` all say it with no quantity attached, and all of them stay true
   * under a weighted schedule. What cannot be said is "N AI actions", because N is credits.
   *
   * And it asserts the POSITIVE half on those keys as well: each must count in this locale's
   * word for the unit. A census that only refused would be satisfied by "500 things". The list is
   * named rather than counted here, and it is now MARKETING ONLY: the subscription pane's entry
   * and the signup funnel's two left with the surfaces that rendered them.
   */
  const CREDIT_COUNTING_KEYS = [
    ["pricing", "trialNote"], ["trial", "terms"], ["faq", "a7"],
  ] as const;

  /** A figure immediately before the action unit — the shape that is a claim about quantity. */
  const COUNTED_ACTIONS = /(?:\d|#|\})\s*(?:AI actions?|KI-Aktion(?:en)?)/i;

  it.each(["en", "de"])("%s: no message counts credits in AI actions", (locale) => {
    const all = JSON.parse(readFileSync(
      fileURLToPath(new URL(`../apps/webapp/messages/${locale}.json`, import.meta.url)), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    const offenders: string[] = [];
    for (const [ns, entries] of Object.entries(all)) {
      if (typeof entries !== "object" || entries === null) continue;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== "string") continue;
        if (COUNTED_ACTIONS.test(value)) offenders.push(`${ns}.${key}`);
      }
    }
    expect(offenders.sort(), `${locale}: these count credits in actions`).toEqual([]);
  });

  it.each([["en", /credits?/i], ["de", /\bCredits?\b/]])(
    "%s: every figure that is a credit balance says so",
    (locale, unit) => {
      const all = JSON.parse(readFileSync(
        fileURLToPath(new URL(`../apps/webapp/messages/${locale}.json`, import.meta.url)), "utf8"),
      ) as Record<string, Record<string, string>>;
      for (const [ns, key] of CREDIT_COUNTING_KEYS) {
        const value = all[ns]?.[key];
        expect(value, `${locale} ${ns}.${key} is missing`).toBeTruthy();
        expect(value, `${locale} ${ns}.${key}: ${JSON.stringify(value)}`).toMatch(unit);
      }
    },
  );

  /**
   * ═══ THE PRICE SCHEDULE THE SITE PRINTS IS THE ONE THE GATE CHARGES ══════════════════════
   *
   * The cases above hold the card's credit ALLOWANCE to `monthlyCredits` and refuse the old
   * flat-action wording on it. What they never read is the one place on the site that prints the
   * EXCHANGE RATE: `faq.a4` states "screening a new sender or filing a message is 1 credit, a
   * drafted reply 15" — figures that are the program's card
   * restated in prose, in both locales, and pinned to nothing at all. Re-price an action and that
   * paragraph becomes a false statement about money on a public page, with every test green: it
   * is the exact shape of the failure this whole file was written for, in the surface that
   * explains the unit rather than sells it.
   *
   * The comparison is on the SET of figures, derived both ways, so it needs no opinion about
   * phrasing or order:
   *
   *   · every distinct price in the schedule must appear in the paragraph — add a fifth metered
   *     action at a new price and the FAQ has to name it;
   *   · every figure in the paragraph must be a price — an invented rate cannot survive there,
   *     and neither can a stale one left behind after a re-pricing.
   *
   * Two weights are equal by design (a workflow step IS a draft, the program's card says so and
   * charges accordingly), and the proposal's price is quoted nowhere (`UNQUOTED` below), so the
   * quoted actions sit at TWO prices. Comparing sets rather than counts is what lets the copy fold
   * the pair into one clause — "a drafted reply 15" — instead of listing a price twice.
   */
  /**
   * THE PRICES ARE LITERALS HERE, and the co-pin is the entitlements program's own test.
   *
   * The schedule is the service operator's, so this repository is no longer where it is
   * declared — there is nothing left to derive `charged` from. Pinning the figures as literals
   * keeps the public paragraph under a gate on this side; the program that charges them pins
   * the same three from its side, and the two are compared when its contract is versioned.
   */
  const FAQ_PRICES = [1, 15] as const;
  /** Charged by the card and quoted nowhere: no person can incur a proposal while nothing schedules
   *  the pass or shows one. The FAQ quotes it again when both exist; until then, quoting it is the
   *  false statement about money this file guards against. */
  const UNQUOTED: ReadonlyArray<keyof typeof PLANE_PRICES> = ["propose"];

  it.each(["en", "de"])("%s: the FAQ's credit prices are the pinned schedule", (locale) => {
    const faq = (JSON.parse(readFileSync(
      fileURLToPath(new URL(`../apps/webapp/messages/${locale}.json`, import.meta.url)), "utf8"),
    ) as { faq: Record<string, string> }).faq;
    const printed = [...new Set((faq.a4!.match(/\d+/g) ?? []).map(Number))].sort((a, b) => a - b);
    expect(printed, `${locale} faq.a4: ${JSON.stringify(faq.a4)}`).toEqual([...FAQ_PRICES]);
  });

  it("the pinned schedule is the program's card — its distinct prices, no more and no fewer", () => {
    const quoted = Object.entries(PLANE_PRICES).filter(([action]) => !UNQUOTED.includes(action as keyof typeof PLANE_PRICES));
    expect(quoted.length, "the unquoted list names an action the card does not price").toBe(Object.keys(PLANE_PRICES).length - UNQUOTED.length);
    const distinct = [...new Set(quoted.map(([, price]) => price))].sort((a, b) => a - b);
    expect(distinct).toEqual([...FAQ_PRICES]);
  });

  /**
   * ONE FIGURE PER STORAGE LINE — which is what makes `firstNumber` above the ADVERTISED count
   * rather than whichever number happens to come first.
   *
   * The line grew a clause in this change, and a clause is where a second number arrives: write
   * "2 GB for the web app" into it and every assertion above still passes while the card
   * advertises 2 emails. The parse is positional by design (the sentence must stay something a
   * translator can rewrite), so the property the parse depends on is pinned here instead of
   * being assumed by it.
   */
  it.each(["en", "de"])("%s: each storage line prints exactly one figure", (locale) => {
    const { pricing } = catalogue(locale);
    for (const tier of TIERS) {
      const groups = pricing[tier.storage]!.replace(/[,.](?=\d{3}\b)/g, "").match(/\d+/g) ?? [];
      expect(groups, `${locale} ${tier.storage}: ${JSON.stringify(pricing[tier.storage])}`)
        .toHaveLength(1);
    }
  });

  it("the storage notice's largest plan is the card's: from it on only the add-on adds room", () => {
    expect(LARGEST_PLAN_STORAGE_BYTES).toBe(Math.max(...Object.values(PLAN_LIMITS).map((p) => p.storageBytes)));
  });

  it("the clients' per-email byte estimate is the plan card's", () => {
    const src = readFileSync(fileURLToPath(
      new URL("../apps/webapp/app/shell/storage-state.ts", import.meta.url)), "utf8");
    const m = src.match(/export const BYTES_PER_STORED_EMAIL_ESTIMATE = ([\d_]+);/);
    expect(m, "the webapp no longer declares the estimate as a literal").not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBe(BYTES_PER_STORED_EMAIL_ESTIMATE);
  });
});
