import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  OhmailEngine,
  ohboxView,
  triagePiles,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MessageStateDTO,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * RE-RESURFACE IS INSTANT AND IT STAYS — "resurface tomorrow" on a row that is resurfaced NOW.
 *
 * ## THE REPORT
 *
 * *"a mail can only ever be in ONE pile; on re-resurface it moves to Resurface immediately and is
 * not visible in Ohbox until its time arrives."* What happened instead: the row left the pin group
 * and reappeared at the TOP of the Ohbox under "New for you", bold, as though it had just arrived —
 * while the Resurface pile listed it. When the read state settled it sank into "Earlier", still
 * listed under Resurface.
 *
 * ## THE MECHANISM, AND WHY THE `unread` FLAG IS NOT THE FIX
 *
 * `mutations.ts#triage_set` applies its `reUnread` patch when `m.state === "resurfaced"` only. A
 * currently-resurfaced row already carries the forced `unread: true` that patch put there, so
 * re-resurfacing writes `bubbled_up` and leaves `unread` set — nothing takes it back. The row then
 * satisfied `newForYou`'s `m.unread` and failed `isResurfaced`, so it was in the Ohbox and in the
 * pile at once.
 *
 * Clearing the flag would hide the symptom and leave the hole: the SAME double presentation is
 * reachable with `unread: false` (it is "Earlier" instead of "New for you"), and reachable for
 * `reply_later` and `set_aside`, which never touch `unread` at all. So the flag is deliberately
 * left exactly as it is and the PILE decides — `selectors.ts#parkedMessageIds`. This file asserts
 * the choreography that follows; `triage-disjoint.test.ts` asserts the property underneath it.
 *
 * ## THE OVERLAY AND THE WIRE ARE BOTH WATCHED
 *
 * One enriched mutation goes down two adapters: the real `HttpAdapter` over a captured `fetch`,
 * which records the literal request, and `FixturesAdapter`, whose echo keeps the mirror coherent so
 * the same fact can be observed surviving a settle. This is the harness `resurface-pin.r12.test.ts`
 * uses and the reason is the same — a guard on the optimistic view alone stays green through
 * exactly the divergence where the overlay parks a row the wire never parked.
 */

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

function spyEngine(now: () => Date = () => DEMO_NOW): {
  engine: OhmailEngine;
  wire: Captured[];
} {
  const inner = new FixturesAdapter({ now });
  const wire: Captured[] = [];
  const http = new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      wire.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      // No `X-Sync-Seq`: the FixturesAdapter's echo below is the only thing that reaches the
      // mirror, so the two cannot race to write it.
      return new Response(JSON.stringify({ id: "echo" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  });

  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: (id: string) => inner.fetchBody(id),
    sync: (p: SyncParams): Promise<SyncResponse> => inner.sync(p),
    async mutate(m: EngineMutation, o: { idempotencyKey: string }): Promise<MutationOutcome> {
      await http.mutate(m, o).catch(() => undefined);
      return inner.mutate(m, o);
    },
  };
  return { engine: new OhmailEngine({ adapter, now }), wire };
}

/** Where the row is, as the six piles see it. */
const placesOf = (engine: OhmailEngine, id: string): string[] => {
  const v = ohboxView(engine.read());
  const p = triagePiles(engine.read());
  const out: string[] = [];
  if (v.resurfaced.some((m) => m.id === id)) out.push("ohbox:resurfaced");
  if (v.newForYou.some((m) => m.id === id)) out.push("ohbox:newForYou");
  if (v.previouslySeen.some((m) => m.id === id)) out.push("ohbox:previouslySeen");
  if (p.replyLater.some((e) => e.messageId === id)) out.push("pile:replyLater");
  if (p.setAside.some((e) => e.messageId === id)) out.push("pile:setAside");
  if (p.resurface.some((e) => e.messageId === id)) out.push("pile:resurface");
  return out;
};

const TOMORROW = "2026-08-03T09:00:00.000Z";

describe("re-resurface: the row moves to Resurface in the first frame and stays there", () => {
  /**
   * THE OWNER'S CHOREOGRAPHY, in order: pinned → deferred → gone from every Ohbox group before any
   * settle → listed under Resurface → still so after the echo.
   *
   * The first-frame half is what the word "immediately" means here, and it is asserted BEFORE the
   * mutation promise is awaited: `Engine.mutate` installs the overlay and notifies synchronously
   * (`engine.ts` — the overlay is set and `notify()` fired before `dispatch`), so a read taken
   * without awaiting is the frame the reader sees.
   */
  it("leaves the Ohbox before the wire answers, and is under Resurface alone", async () => {
    const { engine } = spyEngine();
    await engine.start();

    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    expect(placesOf(engine, "ben")).toEqual(["ohbox:resurfaced"]);

    // THE FIRST FRAME — not awaited. The overlay is already in place.
    const inFlight = engine.mutate({
      kind: "triage_set", messageId: "ben", state: "bubbled_up", bubbleUpAt: TOMORROW,
    });
    expect(
      placesOf(engine, "ben"),
      "the deferred row is still in an Ohbox group in the frame after the press",
    ).toEqual(["pile:resurface"]);

    // …AND AFTER THE SETTLE. The echo may not put it back.
    await inFlight;
    expect(placesOf(engine, "ben")).toEqual(["pile:resurface"]);

    // …AND AFTER A DRAIN, which is the reader that used to disagree with the overlay.
    await engine.syncOnce();
    expect(placesOf(engine, "ben")).toEqual(["pile:resurface"]);
  });

  /**
   * THE WIRE SAYS THE SAME THING. The overlay parking the row is worth nothing if the request that
   * left the client said something else — the row would come back on the next drain from a server
   * that was never told.
   */
  it("the request that leaves the client is the deferral, with the horizon on it", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    await engine.mutate({
      kind: "triage_set", messageId: "ben", state: "bubbled_up", bubbleUpAt: TOMORROW,
    });

    const posts = wire.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://api.test/messages/ben/triage");
    expect(posts[0]!.body).toEqual({ state: "bubbled_up", bubbleUpAt: TOMORROW });
  });

  /**
   * THE FLAG IS UNTOUCHED, AND THAT IS THE POINT.
   *
   * `unread` stays `true` through the deferral — the resurface's forced flag, never taken back —
   * and the row is out of the Ohbox anyway. Pinned here because a later "fix" that clears the flag
   * would make this file pass for the wrong reason and leave `reply_later` / `set_aside` doubling.
   */
  it("the row is still unread, and that no longer decides where it appears", async () => {
    const { engine } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    await engine.mutate({
      kind: "triage_set", messageId: "ben", state: "bubbled_up", bubbleUpAt: TOMORROW,
    });

    const row = engine.read().get<EngineMessage>("message", "ben")!;
    expect(row.unread).toBe(true);
    expect(row.triage?.state).toBe("bubbled_up");
    expect(row.triage?.bubbleUpAt).toBe(TOMORROW);
    expect(placesOf(engine, "ben")).toEqual(["pile:resurface"]);
  });

  /**
   * A LATE SETTLE ECHO CANNOT RESURRECT IT INTO "EARLIER".
   *
   * The other half of the report: the row sank into Earlier when its read state settled. So read
   * it AFTER the deferral — the exact sequence — and it must still be nowhere in the Ohbox.
   */
  it("marking the deferred row read does not file it into Earlier", async () => {
    let t = DEMO_NOW.getTime();
    const { engine } = spyEngine(() => new Date(t));
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    t += 60_000;
    await engine.mutate({
      kind: "triage_set", messageId: "ben", state: "bubbled_up", bubbleUpAt: TOMORROW,
    });

    t += 60_000;
    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });
    expect(engine.read().get<EngineMessage>("message", "ben")!.unread).toBe(false);
    expect(
      placesOf(engine, "ben"),
      "the read state settled and the row came back as Earlier",
    ).toEqual(["pile:resurface"]);

    await engine.syncOnce();
    expect(placesOf(engine, "ben")).toEqual(["pile:resurface"]);
  });

  /**
   * THE ROW COMES BACK WHEN ITS TIME ARRIVES — "not visible in Ohbox UNTIL ITS TIME COMES" is
   * half a promise without this, and a fix that simply hid parked mail for ever would pass
   * everything above.
   *
   * The due flip is the worker's (`bubbleUpPass` writes `resurfaced`, never straight to `none`),
   * and `triage_set { state: "resurfaced" }` is that same transition at the other trigger — which
   * is exactly how `resurface-pin.r12.test.ts` stands a pin up. Under the pin discipline the
   * returned row is unread and pinned, and it is in the pin group ALONE: the `bubbled_up` record it
   * came from is replaced, not joined.
   */
  it("comes back to the pin group, alone, when the deferral is redeemed", async () => {
    const { engine } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    await engine.mutate({
      kind: "triage_set", messageId: "ben", state: "bubbled_up", bubbleUpAt: TOMORROW,
    });
    expect(placesOf(engine, "ben")).toEqual(["pile:resurface"]);

    // Its time arrives.
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });

    expect(placesOf(engine, "ben")).toEqual(["ohbox:resurfaced"]);
    expect(engine.read().get<EngineMessage>("message", "ben")!.unread).toBe(true);
    // ONE record for the message, at the settled id — a second would be a second claim, and
    // `triage-pile-parity.test.ts` is the file that explains what two claims cost.
    const records = engine.read().entries<MessageStateDTO>("message_state")
      .filter((e) => (e.entity?.messageId ?? e.id) === "ben");
    expect(records).toHaveLength(1);
    expect(records[0]!.entity.state).toBe("resurfaced");
  });
});
