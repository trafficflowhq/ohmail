import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  OhmailEngine,
  isResurfaced,
  ohboxView,
  readsPartition,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * A RESURFACED ROW STAYS PINNED UNTIL IT IS ANSWERED OR DELIBERATELY MARKED READ.
 *
 * The server has always stated the rule and enforced it (`MessageService.spendResurface`:
 * "Merely OPENING the row is deliberately neither: a glance does not spend the resurface").
 * `feed_mark_seen` is the client's *glance* verb — the per-card dwell mark and the leave-commit
 * both ride it — and the Ohbox's dwell commit is `mark_seen` with `via: "glance"`. Neither may
 * take the pin down.
 *
 * HOW THE GLANCE IS NARROWED CHANGED ON 2026-08-26 (a ruling). The first pin fix FILTERED
 * pinned ids out of both glance verbs at `Engine.enrich`, which protected the pin by DROPPING
 * THE READ: a pinned row presented as read while open and turned back to unread on leave,
 * because nothing ever landed. The ruling replaced it — a resurfaced message keeps its GENUINE
 * read state and reading it sticks like anywhere else — so the glance now TRAVELS: every id
 * goes out, labelled `via: "glance"`, and the SERVER marks read without spending the pin
 * (`MessageService.markSeen`/`patch`). The reads-stick half lives in
 * `resurface-read-sticks.test.ts`; THIS file owns the half that survived: a glance never spends
 * the pin, and the deliberate verbs still do.
 *
 * Every assertion that matters watches the ADAPTER'S OUTGOING PATCH BODY rather than the
 * optimistic view: the label is only worth anything if it is on the request the server sees,
 * and a guard on the overlay alone would stay green through exactly that divergence.
 */

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A DEMO ENGINE THAT ALSO SPEAKS THE REAL WIRE.
 *
 * `mutate` is handed to BOTH implementations of `EngineAdapter` that ship: the real
 * `HttpAdapter` over a captured `fetch`, which records the literal outgoing requests, and the
 * `FixturesAdapter`, whose echo keeps the mirror coherent so the pin can be observed surviving a
 * settle. One enriched mutation object goes down both paths — which is the fact under test, since
 * the demo backend derives its changes from `mutationEffects` and the HTTP adapter derives its
 * requests from `m.messageIds`. If those two ever disagreed about which ids a glance touches,
 * this harness is where it would show.
 */
function spyEngine(now: () => Date = () => DEMO_NOW): {
  engine: OhmailEngine;
  wire: Captured[];
  mutations: EngineMutation[];
} {
  // THE SAME CLOCK ON BOTH SIDES. The demo backend recomputes the effects it echoes with its own
  // `now`, so an adapter left on the default fixed instant would stamp every `lastReadAt` with the
  // same value and flatten the reading ORDER this file asserts on into an id tiebreak.
  const inner = new FixturesAdapter({ now });
  const wire: Captured[] = [];
  const mutations: EngineMutation[] = [];

  const http = new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      wire.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      // No `X-Sync-Seq`: the adapter fabricates no changes, so the FixturesAdapter's echo below
      // is the only thing that reaches the mirror and the two cannot race to write it.
      return new Response(JSON.stringify({ id: "echo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  });

  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: (id: string) => inner.fetchBody(id),
    sync: (p: SyncParams): Promise<SyncResponse> => inner.sync(p),
    async mutate(m: EngineMutation, o: { idempotencyKey: string }): Promise<MutationOutcome> {
      // The mutation AS FROZEN ON THE QUEUE — post-enrichment, which is the object the real
      // adapter would iterate and the one whose id list this slice narrows.
      mutations.push(m);
      // Records the literal PATCHes; its own outcome is discarded in favour of the demo echo.
      await http.mutate(m, o).catch(() => undefined);
      return inner.mutate(m, o);
    },
  };

  return { engine: new OhmailEngine({ adapter, now }), wire, mutations };
}

const patches = (wire: Captured[]): Captured[] => wire.filter((c) => c.method === "PATCH");
const pinnedIn = (engine: OhmailEngine): string[] =>
  ohboxView(engine.read()).resurfaced.map((m) => m.id);

describe("the leave-commit is a glance and must not spend a resurface", () => {
  /**
   * GUARD 1. The exact production sequence: a pinned row is on screen when the reader leaves the
   * stream, and the departure commits `feed_mark_seen` over everything that was visible. The
   * pinned row's read TRAVELS — labelled — and the pin stands.
   */
  it("PATCHes the pinned row as a glance and leaves the pin standing", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();

    // `f1` is a Reads row; pin it the way the worker's due-resurface pass does.
    await engine.mutate({ kind: "triage_set", messageId: "f1", state: "resurfaced" });
    expect(pinnedIn(engine)).toEqual(["f1"]);
    wire.length = 0;

    // THE LEAVE-COMMIT — the anchor plus every unread id the final screen covered, pin included.
    const res = await engine.mutate({
      kind: "feed_mark_seen",
      view: "reads",
      upToId: "f2",
      messageIds: ["f1", "f2"],
    });
    expect(res.status).toBe("confirmed");

    // ── THE ASSERTION THAT MATTERS: what actually left the client ────────────────────────────
    const byUrl = new Map(patches(wire).map((c) => [c.url, c.body]));
    expect(byUrl.get("https://api.test/messages/f1"),
      "the pinned row's read must travel, labelled, so the server can decline to spend the pin")
      .toEqual({ unread: false, via: "glance" });
    expect(byUrl.get("https://api.test/messages/f2")).toEqual({ unread: false, via: "glance" });
    expect(patches(wire)).toHaveLength(2);

    // The read LANDED and the pin survives the settle echo, wire and demo world alike.
    const r = engine.read();
    expect(isResurfaced(r.get<EngineMessage>("message", "f1")!)).toBe(true);
    expect(r.get<EngineMessage>("message", "f1")!.unread, "reading a pinned row sticks").toBe(false);
    expect(pinnedIn(engine)).toEqual(["f1"]);
    expect(r.get<EngineMessage>("message", "f2")!.unread).toBe(false);

    // The waterline still moved: leaving is still a leave.
    expect(readsPartition(engine.read()).waterline?.newestSeenId).toBe("f2");
  });

  /**
   * The per-card dwell mark takes the same route with a single id and no anchor, and it is the
   * one that fires while a reader is merely scrolling. The read lands — labelled — and the pin
   * stands.
   */
  it("a dwell-mark on a pinned card reads it as a glance and keeps the pin", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "f1", state: "resurfaced" });
    wire.length = 0;

    const res = await engine.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: ["f1"] });

    expect(res.status).toBe("confirmed");
    expect(patches(wire)).toHaveLength(1);
    expect(patches(wire)[0]!.url).toBe("https://api.test/messages/f1");
    expect(patches(wire)[0]!.body).toEqual({ unread: false, via: "glance" });
    expect(engine.read().get<EngineMessage>("message", "f1")!.unread).toBe(false);
    expect(pinnedIn(engine)).toEqual(["f1"]);
  });

  /**
   * GUARD 3, the anchored half. A leave whose visible set was ENTIRELY pinned reads the pinned
   * row (as a glance) AND moves the line — and the pin still stands at the end of it.
   */
  it("an all-pinned leave-commit reads the pin, moves the line, keeps the pin", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "f1", state: "resurfaced" });
    wire.length = 0;

    const res = await engine.mutate({
      kind: "feed_mark_seen",
      view: "reads",
      upToId: "f1",
      messageIds: ["f1"],
    });
    expect(res.status).toBe("confirmed");
    expect(patches(wire)).toHaveLength(1);
    expect(patches(wire)[0]!.body).toEqual({ unread: false, via: "glance" });
    expect(pinnedIn(engine)).toEqual(["f1"]);
    expect(readsPartition(engine.read()).waterline?.newestSeenId).toBe("f1");
  });

  /**
   * THE WHOLE-FEED FORM fills its own id list inside `enrich` rather than receiving one, so it is
   * a second code path to the same wire and it needs its own assertion. "Mark everything read"
   * is a sweep, not an answer to any particular message — the pinned row is READ by it and stays
   * pinned.
   */
  it("the un-idded whole-feed sweep reads the pin without spending it", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "f1", state: "resurfaced" });
    wire.length = 0;

    await engine.mutate({ kind: "feed_mark_seen", view: "reads" });

    const urls = patches(wire).map((c) => c.url);
    expect(urls, "the pinned row is part of the sweep now — its read sticks")
      .toContain("https://api.test/messages/f1");
    expect(urls.length).toBeGreaterThan(1); // the rest of Reads was genuinely swept
    expect(engine.read().get<EngineMessage>("message", "f1")!.unread).toBe(false);
    expect(pinnedIn(engine)).toEqual(["f1"]);
  });
});

/**
 * THE OHBOX IS WHERE PINS ACTUALLY LIVE, AND IT DOES NOT USE `feed_mark_seen`.
 *
 * `ohboxView.resurfaced` is the only home a resurfaced row has. `feed_mark_seen` is a STREAM
 * verb — Reads and Receipts — and its optimistic effect drops every id outside the view's folder
 * by construction, which is exactly why the Ohbox was never allowed to use it. The Ohbox marks
 * mail read through `mark_seen`, on a two-second cursor dwell whose debt is spent on the way out
 * (`OhboxView.commitPendingRead`, fired by leaving the view, closing the reader at a narrow
 * width, or `pagehide`). So the headline case — "resurface a message, open it, navigate away" —
 * runs through `mark_seen` and not through the verb above.
 *
 * A dwell commit and a deliberate read are byte-identical at this boundary: same verb, same ids,
 * same `unread: false`. The surface that decided for the reader is the only thing that can tell
 * them apart, so it says so with `via: "glance"` — and since the 2026-08-26 ruling the label
 * TRAVELS: the read goes out and lands (it sticks), while the server declines to spend the pin.
 * Guessing instead — "a single id must be deliberate" — would be a heuristic undoing an explicit
 * act, which is the thing `OhboxView`'s own `u` handler is written at length to prevent.
 */
describe("the Ohbox dwell is a glance too", () => {
  it("a glance-labelled mark_seen reads the row, labelled, and leaves the pin standing", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    // The dwell commit, exactly as `OhboxView.commitPendingRead` issues it.
    const res = await engine.mutate({
      kind: "mark_seen",
      messageIds: ["ben"],
      unread: false,
      via: "glance",
    });

    expect(res.status, "the read must land — dropping it was the reported flip-back").toBe("confirmed");
    expect(patches(wire)).toHaveLength(1);
    expect(patches(wire)[0]!.body, "the label must be ON the request, or the server spends the pin")
      .toEqual({ ids: ["ben"], unread: false, via: "glance" });
    const m = engine.read().get<EngineMessage>("message", "ben")!;
    expect(isResurfaced(m)).toBe(true);
    expect(m.unread, "the read sticks; the pin is what a glance cannot touch").toBe(false);
    expect(pinnedIn(engine)).toEqual(["ben"]);
  });

  it("a glance over a MIXED batch reads every row and holds only the PIN back", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    await engine.mutate({
      kind: "mark_seen",
      messageIds: ["ben", "petra"],
      unread: false,
      via: "glance",
    });

    // ONE batch PATCH, both ids, labelled — the assertion on the real wire body.
    expect(patches(wire)).toHaveLength(1);
    expect(patches(wire)[0]!.body).toEqual({ ids: ["ben", "petra"], unread: false, via: "glance" });
    expect(pinnedIn(engine)).toEqual(["ben"]);
    expect(engine.read().get<EngineMessage>("message", "ben")!.unread).toBe(false);
    expect(engine.read().get<EngineMessage>("message", "petra")!.unread).toBe(false);
  });

  /**
   * THE DEFAULT IS DELIBERATE, and this is the assertion that keeps the fix from swallowing the
   * feature. An unlabelled `mark_seen` is the read pill, `⇧I`, bulk and read-all; every one of
   * them must go on answering a pin. If `via` were ever inverted — or defaulted the other way —
   * releasing a resurfaced row by hand would become impossible and nothing else would fail.
   */
  it("an UNLABELLED mark_seen still spends the pin — glance is opt-in", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });

    expect(patches(wire)[0]!.body).toEqual({ ids: ["ben"], unread: false });
    expect(pinnedIn(engine)).toEqual([]);
  });

  /**
   * Marking UNREAD never spent a resurface on either side of the wire, and the label changes
   * nothing about that direction: the id travels, the pin stands.
   */
  it("a glance marking UNREAD travels and leaves the pin alone", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: true, via: "glance" });

    expect(patches(wire)[0]!.body).toEqual({ ids: ["ben"], unread: true, via: "glance" });
    expect(pinnedIn(engine)).toEqual(["ben"]);
    expect(engine.read().get<EngineMessage>("message", "ben")!.unread).toBe(true);
  });
});

describe("the two verbs that DO answer a pin still spend it", () => {
  /**
   * GUARD 2. `mark_seen` is the deliberate act — the pill, the keyboard verb, the bulk selection,
   * read-all — and it is untouched by this slice. It spends the resurface and it stamps
   * `lastReadAt`, which stays the row's reading STATE. Since the arrival ruling (owner
   * 2026-09-18) the released row returns to its ARRIVAL slot in "Earlier" — a read never moves
   * a row, so release-order may not rank it.
   *
   * The fixture makes that distinguishable. `ben` is the OLDEST unread Ohbox row and
   * `cinderlock` is newer than it; `cinderlock` is read FIRST and `ben` released after it. A
   * reading-order list would put the just-released `ben` on top; arrival keeps `cinderlock`
   * above it.
   *
   * The sibling is `cinderlock` and NOT the newest row `giulia`, because `giulia` is parked in the
   * demo's Answer Later pile and a parked row is in no Ohbox group at all
   * (`selectors.ts#parkedMessageIds`) — reading it would put it in "Earlier" nowhere, and the
   * `indexOf` below would be `-1` for a reason that has nothing to do with the order.
   */
  it("a manual mark_seen releases the pin and returns the row to its ARRIVAL slot in Earlier", async () => {
    let t = DEMO_NOW.getTime();
    const { engine, wire } = spyEngine(() => new Date(t));
    await engine.start();

    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    expect(pinnedIn(engine)).toEqual(["ben"]);

    // A sibling read EARLIER, and a newer message by date — the row a date sort would rank first.
    t += 60_000;
    await engine.mutate({ kind: "mark_seen", messageIds: ["cinderlock"], unread: false });

    t += 60_000;
    wire.length = 0;
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });
    expect(res.status).toBe("confirmed");

    // The manual verb is a BATCH PATCH and it still carries the pinned id — untouched by that change.
    expect(patches(wire)).toHaveLength(1);
    expect(patches(wire)[0]!.url).toBe("https://api.test/messages");
    expect(patches(wire)[0]!.body).toEqual({ ids: ["ben"], unread: false });

    const view = ohboxView(engine.read());
    expect(view.resurfaced, "the pin is answered and gone").toEqual([]);
    const ids = view.previouslySeen.map((m) => m.id);
    expect(ids, "the released row is in Earlier").toContain("ben");
    // …BELOW the sibling that was read a minute earlier but arrived later: arrival order, and
    // the release instant ranks nothing.
    expect(ids.indexOf("cinderlock"), "arrival order, never release order").toBeLessThan(ids.indexOf("ben"));
  });

  /**
   * "Answered" needs no detection of its own: settling a reply marks the parent read through the
   * single-message PATCH, which is a spending route on the server. This asserts the client half —
   * that the release is a plain read of the parent, landing it in Earlier at its arrival slot.
   */
  it("marking the parent read on reply releases the pin the same way", async () => {
    let t = DEMO_NOW.getTime();
    const { engine } = spyEngine(() => new Date(t));
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });

    t += 60_000;
    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });

    const view = ohboxView(engine.read());
    expect(view.resurfaced).toEqual([]);
    expect(view.previouslySeen.map((m) => m.id)).toContain("ben");
  });
});

describe("the demo backend agrees, on its own", () => {
  /**
   * The `?demo` surface runs the same mutations through `FixturesAdapter`, which builds its
   * changes from `mutationEffects` — the other reader of the enriched mutation. The glance
   * semantics live in the effects themselves (no `spentResurface` on a glance), so one seam
   * covers this path; this asserts that rather than assuming it, with no HTTP in the picture.
   */
  it("a glance reads the pinned row in ?demo without unpinning; a manual read takes the pin down", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "f1", state: "resurfaced" });

    await engine.mutate({ kind: "feed_mark_seen", view: "reads", upToId: "f2", messageIds: ["f1", "f2"] });
    expect(ohboxView(engine.read()).resurfaced.map((m) => m.id)).toEqual(["f1"]);
    expect(engine.read().get<EngineMessage>("message", "f1")!.unread, "the glance's read sticks in demo too")
      .toBe(false);

    await engine.mutate({ kind: "mark_seen", messageIds: ["f1"], unread: false });
    expect(ohboxView(engine.read()).resurfaced).toEqual([]);
  });
});
