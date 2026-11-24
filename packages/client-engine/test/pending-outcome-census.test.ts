import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY ADAPTER CASE THAT CAN MEET A 202 READS IT AS ONE.
 *
 * The defect this refuses was one case at a time: `screener_decide` read `pending: true` and
 * Move, Delete and the three rule verbs did not, so a request recorded for the organizer came
 * back through the same door as a completion. The rule cannot be a list somebody keeps up to
 * date — it is DERIVED: the API's own routes say which doors answer 202 with a pending body, the
 * adapter's own `mutate` says which case knocks on which door, and every pair of the two must
 * read {@link HttpAdapter.queuedAnswer}.
 *
 * Both sides are read with comments blanked (`source-scan.mjs`), because "202" and "pending"
 * appear in prose all over these files and a census that counts prose measures nothing.
 */

const ROUTES_DIR = new URL("../../api/src/routes/", import.meta.url);
const ADAPTER = new URL("../src/adapters/http-adapter.ts", import.meta.url);

/**
 * A pair the census names and deliberately does not require, with the reason. Only one, and it is
 * a fact about the REQUEST this case sends rather than about the route: `PATCH /messages/:id`
 * answers 202 for the `folder` half of a patch, and `feed_mark_seen` sends `{unread, via}` — no
 * folder, so the queued arm is unreachable from it. A case that starts sending `folder` breaks
 * this pin, which is the point of writing it as a pin rather than as silence.
 */
const PINNED: Record<string, string> = {
  'feed_mark_seen PATCH /messages/:x':
    "sends {unread, via} only — the folder half that produces the 202 is not reachable from this case",
};

/** `/messages/${m.id}/move` → `/messages/:x/move`; a route's `/messages/:id/move` → the same. */
const shape = (path: string): string =>
  path
    .replace(/\$\{[^}]*\}/g, ":x")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x")
    .replace(/\?.*$/, "");

/** The (method, pattern) pairs whose route can answer 202 with a PENDING body. */
function queuedCapableRoutes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(ROUTES_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const src = withoutComments(readFileSync(new URL(name, ROUTES_DIR), "utf8"));
    // Route objects in these files all begin at a `method:` line; a block runs to the next one.
    const starts = [...src.matchAll(/^\s*method: "([A-Z]+)",/gm)];
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i]!.index!;
      const to = i + 1 < starts.length ? starts[i + 1]!.index! : src.length;
      const block = src.slice(from, to);
      const pattern = /pattern: "([^"]+)"/.exec(block)?.[1];
      if (!pattern) continue;
      // A 202 is queued-for-the-organizer when `pending` is stated in the same breath — the line
      // that produces the status, or the two above it for a multi-line response.
      const lines = block.split("\n");
      const queued = lines.some((line, n) =>
        /\b202\b/.test(line) && lines.slice(Math.max(0, n - 2), n + 1).some((l) => /\bpending\b/.test(l)));
      if (queued) found.set(`${starts[i]![1]} ${shape(pattern)}`, `${name}: ${pattern}`);
    }
  }
  return found;
}

/** Each `case "<kind>"` of the adapter's `mutate` switch, with the requests it makes. */
function adapterCases(): Array<{ kind: string; requests: string[]; readsQueued: boolean }> {
  const src = withoutComments(readFileSync(ADAPTER, "utf8"));
  const at = src.indexOf("async mutate(");
  expect(at, "the adapter's mutate switch moved — this census reads it by name").toBeGreaterThan(0);
  const body = src.slice(at);
  const starts = [...body.matchAll(/^      case "([a-z_]+)":/gm)];
  return starts.map((m, i) => {
    const from = m.index!;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : body.length;
    const block = body.slice(from, to);
    // A case asks through `this.call("METHOD /pattern", …)`: the wire's name for the route.
    const requests = [...block.matchAll(/this\.call\(\s*"([A-Z]+) (\/[^"]*)"/g)]
      .map((r) => `${r[1]} ${shape(r[2]!)}`);
    return { kind: m[1]!, requests, readsQueued: block.includes("this.queuedAnswer(") };
  });
}

describe("the 202 census — no adapter case settles a request as a completion", () => {
  /** THE PREMISE, measured: a census over an empty set of routes would pass for nothing. */
  it("derives the queued-capable routes from the API, and there are some", () => {
    const routes = queuedCapableRoutes();
    expect(routes.size, "no route was read as answering a pending 202 — the derivation broke").toBeGreaterThanOrEqual(5);
    expect([...routes.keys()]).toContain("POST /messages/:x/move");
    expect([...routes.keys()]).toContain("DELETE /messages/:x");
  });

  /** …and the adapter's own switch is read, not assumed. */
  it("reads the adapter's mutate cases, and they knock on real doors", () => {
    const cases = adapterCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.find((c) => c.kind === "move")?.requests).toContain("POST /messages/:x/move");
  });

  it("every case that can meet a 202 reads it through the one door", () => {
    const routes = queuedCapableRoutes();
    const owed: string[] = [];
    const pinsUsed = new Set<string>();
    for (const c of adapterCases()) {
      for (const r of c.requests) {
        if (!routes.has(r)) continue;
        const pin = `${c.kind} ${r}`;
        if (PINNED[pin]) { pinsUsed.add(pin); continue; }
        if (!c.readsQueued) owed.push(`${pin} (${routes.get(r)})`);
      }
    }
    expect(owed, "a mutation case can be answered 202 and reads it as a completion").toEqual([]);
    // A pin for a pair that no longer exists is a claim about nothing — it goes when it stops
    // being true, not when somebody notices.
    expect([...Object.keys(PINNED)].filter((p) => !pinsUsed.has(p)), "a stale pin").toEqual([]);
  });

  /** THE VERBS THE FINDING NAMED, by name, so a rename cannot quietly drop one. */
  it("move, message_delete, screener_decide and the three rule verbs all read it", () => {
    const byKind = new Map(adapterCases().map((c) => [c.kind, c]));
    for (const kind of ["move", "message_delete", "screener_decide", "rule_create", "rule_update", "rule_delete"]) {
      expect(byKind.get(kind)?.readsQueued, `${kind} does not read the queued answer`).toBe(true);
    }
  });
});
