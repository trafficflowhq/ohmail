import { describe, it, expect } from "vitest";
import { apiRoutes, type ReplayDisposition, type Route } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";

/**
 * EVERY SPENDER DECLARES WHAT A SECOND ARRIVAL COSTS. The disposition lives ON THE ROUTE
 * ({@link ReplayDisposition}); this file is the RULE — exactly one disposition per spender,
 * `mints` refused, the arithmetic frozen so a count that moves without a diff is a route that
 * arrived. It used to be a hand-written inventory, which could not tell a replay-safe route from
 * one nobody had looked at. All four published tables are read, deduplicated by `METHOD pattern`:
 * the hosted one alone hid two self-host-only spenders.
 */

const key = (r: Route): string => `${r.method} ${r.pattern}`;

/** Every route that CAUSES COST — the spend gate's own `work` and `paid` classes, all tables. */
const spenders: Route[] = (() => {
  const seen = new Map<string, Route>();
  for (const table of [apiRoutes, localRoutes, selfHostRoutes, desktopHostRoutes]) {
    for (const r of table) {
      if (r.cost !== "work" && r.cost !== "paid") continue;
      if (!seen.has(key(r))) seen.set(key(r), r);
    }
  }
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)));
})();

/**
 * Spenders whose replay is handled by `withIdempotency`: the middleware looks the key up, replays
 * the stored response verbatim, and the handler's service claims the row INSIDE its own mutation
 * transaction. That IS the disposition, so these carry no `replay` of their own.
 */
const keyedByMiddleware = spenders.filter((r) => r.options?.idempotent === true);
const declared = spenders.filter((r) => r.replay !== undefined);
const withDisposition = (d: ReplayDisposition): Route[] => spenders.filter((r) => r.replay === d);

describe("the idempotency census over everything that spends", () => {
  /**
   * THE GATE. A spender with neither the flag nor a declaration is a route nobody has decided
   * about, and the failure message hands the author the exact string to go and place.
   *
   * WATCHED RED by the planted route below, and by mounting a real `cost: "work"` route with
   * neither: it appears here by name.
   */
  it("every spender declares a disposition — no remainder", () => {
    const undecided = spenders
      .filter((r) => r.options?.idempotent !== true && r.replay === undefined)
      .map(key);
    expect(
      undecided,
      "a route that spends was mounted without saying what a second arrival of it costs — "
      + "give it `replay:` (see ReplayDisposition) or `options: { idempotent: true }`",
    ).toEqual([]);
  });

  /** AND NEVER BOTH — two spellings of one fact drift, and the census would read the weaker. */
  it("a keyed route does not also declare a disposition", () => {
    expect(keyedByMiddleware.filter((r) => r.replay !== undefined).map(key)).toEqual([]);
  });

  /**
   * A ROUTE THAT MINTS MUST PRESENT A KEY BEFORE THE EFFECT. This is the one disposition the
   * census refuses: there is nothing for a second insert to resolve on, so the only thing that
   * can tell a retry from a deliberate duplicate is the key.
   *
   * It is DECLARABLE rather than unrepresentable on purpose — a refusal whose state cannot be
   * reached is a refusal nobody has watched fail. The fixture below reaches it.
   */
  it("no spender declares `mints` — a minting route is keyed instead", () => {
    expect(
      withDisposition("mints").map(key),
      "this route mints a durable row per call, so it takes `options: { idempotent: true }` and "
      + "its service claims the key inside the insert transaction",
    ).toEqual([]);
  });

  /**
   * THE REFUSALS, DRIVEN. Two planted routes, judged by the same predicates the cases above use
   * — the assertions are on the route table, so this is how their bodies are watched fail
   * without mutating the table every other suite reads.
   */
  it("the rules refuse a planted spender — both of them", () => {
    const undecided = { method: "POST", pattern: "/planted", cost: "work", relay: false } as unknown as Route;
    const minting = { ...undecided, replay: "mints" as const } as unknown as Route;
    const both = { ...undecided, replay: "state" as const, options: { idempotent: true } } as unknown as Route;

    expect([undecided].filter((r) => r.options?.idempotent !== true && r.replay === undefined))
      .toHaveLength(1);
    expect([minting].filter((r) => r.replay === "mints")).toHaveLength(1);
    expect([both].filter((r) => r.options?.idempotent === true && r.replay !== undefined))
      .toHaveLength(1);

    // AND THE ORDINARY CASES ARE ADMITTED — a keyed route, and an honest read-shaped write that
    // declares why a replay is free. Without these the three above could pass by refusing
    // everything.
    const keyed = { ...undecided, options: { idempotent: true } } as unknown as Route;
    const honest = { ...undecided, replay: "state" as const } as unknown as Route;
    for (const r of [keyed, honest]) {
      expect(r.options?.idempotent === true || r.replay !== undefined).toBe(true);
      expect(r.replay === "mints").toBe(false);
    }
  });

  /**
   * The mint is keyed BY ITS OWN HANDLER, and this is the assertion that would have been red
   * before the fix: it was in neither keyed set and nothing said so.
   *
   * WATCHED RED by changing its disposition to anything else.
   */
  it("the attachment-staging mint reads the key itself", () => {
    const mint = spenders.find((r) => key(r) === "POST /attachments/staging");
    expect(mint?.replay).toBe("handler");
  });

  /** The arithmetic, frozen. A count that moves without a diff to the table is a route added. */
  it("the totals are what they are", () => {
    // 75 -> 77: the two self-host-only device-OAuth routes, which the old census could not see
    // because it read `apiRoutes` alone. Nothing about them changed; this file's reach did.
    // 77 -> 78 with the undecided-sender press, `guarded` on its own route: a moved message is
    // desired into the Screener, which the candidate query excludes, so a replay writes nothing.
    // 78 -> 79 with the profile replace, `state` like the decline beside it: a second press finds
    // the `replaced` row already there and writes nothing.
    // 79 -> 80 with the checkout confirm, `ephemeral` like the manage link: a second press asks the
    // program again and the program's own event ids make the apply idempotent.
    // 80 -> 81 with clearing a refused "Not junk", `state`: a replay finds no refused row.
    // 81 -> 82 with the Screener's put-back, `guarded` on its own route: a message put back is at
    // the gate and no longer where the pass filed it, so a replay puts nothing back.
    // 82 -> 83 with the gap offer's answer, `state`: a replayed File finds the press already there.
    // 83 -> 85 with the waiting filings' two presses: Try again `state` (a replay re-arms rows
    // already armed), Leave `guarded` (a settled row is no longer pending, so a replay settles none).
    expect(spenders).toHaveLength(85);
    // 19 -> 25 with the six creates that mint a durable row per call and now claim their key:
    // snippets, kb, notify-rules, the two notes and workflows.
    // 25 -> 26 with the tag create, which claims its key: a retry whose answer was lost met the
    // name rule over the tag it had made.
    expect(keyedByMiddleware).toHaveLength(26);
    expect(declared).toHaveLength(85 - 26);
    // Per disposition, so a route that CHANGES its answer moves two numbers rather than none.
    expect(withDisposition("handler").map(key))
      .toEqual(["DELETE /rules/:id", "POST /attachments/staging"]);
    expect(withDisposition("state")).toHaveLength(41);
    expect(withDisposition("guarded")).toHaveLength(12);
    expect(withDisposition("ephemeral").map(key)).toEqual([
      "POST /account/checkout/confirm",
      "POST /account/manage-link",
      "POST /mailboxes/oauth/microsoft/device/start",
      "POST /mailboxes/oauth/microsoft/start",
    ]);
  });
});
