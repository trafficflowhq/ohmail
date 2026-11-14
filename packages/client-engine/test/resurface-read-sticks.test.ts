import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  OhmailEngine,
  isResurfaced,
  ohboxView,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * A RESURFACED MESSAGE KEEPS ITS GENUINE READ STATE, AND READING IT STICKS.
 *
 * ## THE REPORT (owner, 2026-08-26)
 *
 * *"A resurfaced message gets marked unread but stays resurfaced and turns back to unread."*
 * The user opened a pinned row, watched it present as read, navigated away — and it was bold
 * again. Reading a resurfaced message did not stick.
 *
 * ## THE MECHANISM
 *
 * Two halves, both deliberate under the OLD ruling and both removed by the new one:
 *
 *  1. **The artificial unread.** The due flip (`bubbleUpPass`) and `resurface_now`
 *     (`TriageService.setState`) forced `unread = true` + `lastReadAt = null` and queued a
 *     `\Seen` removal against the real mailbox — so every pin arrived bold whatever its real
 *     state, and a worker-side rescue pass re-applied the mark to rows it decided were owed one.
 *  2. **The dropped read.** The Ohbox marks mail read on a cursor dwell committed on the way out
 *     (`mark_seen` with `via: "glance"`), and `Engine.enrich` FILTERED pinned ids out of that
 *     mutation entirely (`withoutPins`) so a glance could not spend the pin. The row presented
 *     as read while armed (`OhboxView.effUnread`), the commit then carried nothing, and the row
 *     reverted to bold. That reversion is the "turns back to unread".
 *
 * ## THE RULING (owner, 2026-08-26)
 *
 * Placement in Resurface IS the attention signal. No artificial unread anywhere: a resurfaced
 * message keeps its genuine read state, and reading it sticks like anywhere else. What SURVIVES
 * is the narrower rule that a glance does not spend the PIN — so the glance now travels on the
 * wire (`via: "glance"`) and the server marks read WITHOUT clearing `resurfaced`, instead of the
 * client suppressing the read to protect the pin.
 *
 * Same double-adapter harness as `resurface-pin.r12.test.ts`: the literal wire body is asserted,
 * not just the optimistic view, because the defect lived exactly in the gap between them.
 */

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

function spyEngine(now: () => Date = () => DEMO_NOW): {
  engine: OhmailEngine;
  wire: Captured[];
  mutations: EngineMutation[];
} {
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
      mutations.push(m);
      await http.mutate(m, o).catch(() => undefined);
      return inner.mutate(m, o);
    },
  };
  return { engine: new OhmailEngine({ adapter, now }), wire, mutations };
}

const patches = (wire: Captured[]): Captured[] => wire.filter((c) => c.method === "PATCH");
const pinnedIn = (engine: OhmailEngine): string[] =>
  ohboxView(engine.read()).resurfaced.map((m) => m.id);

describe("reading a resurfaced message sticks — the reported flip-back, reproduced end to end", () => {
  /**
   * THE HEADLINE SEQUENCE: resurface a message, read it (the dwell commit — exactly what
   * `OhboxView.commitPendingRead` dispatches), and it must BE read — locally, on the wire, and
   * after the next sync cycle. Under the old code the glance was filtered to nothing: the
   * mutation rolled back, no request left the client, and the row turned back to unread.
   */
  it("a glance-read of a pinned row lands, goes on the wire, and survives the next sync", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    const res = await engine.mutate({
      kind: "mark_seen",
      messageIds: ["ben"],
      unread: false,
      via: "glance",
    });
    expect(res.status, "the read must be applied, not rolled back as an empty mutation").toBe("confirmed");

    // The read STUCK…
    const m = engine.read().get<EngineMessage>("message", "ben")!;
    expect(m.unread, "reading a resurfaced message sticks like anywhere else").toBe(false);
    // …the pin stands (a glance answers nothing — placement is the signal)…
    expect(isResurfaced(m)).toBe(true);
    expect(pinnedIn(engine)).toEqual(["ben"]);
    // …and the wire carried the read WITH its glance label, so the server marks read without
    // spending the pin instead of the client suppressing the read.
    expect(patches(wire)).toHaveLength(1);
    expect(patches(wire)[0]!.body).toEqual({ ids: ["ben"], unread: false, via: "glance" });

    // THE NEXT CYCLE: no pass, sync or echo may take the read back.
    await engine.syncOnce();
    const after = engine.read().get<EngineMessage>("message", "ben")!;
    expect(after.unread, "the next sync cycle turned it back to unread — the reported flip-back").toBe(false);
    expect(isResurfaced(after)).toBe(true);
  });

  /**
   * NO ARTIFICIAL UNREAD: resurfacing a READ row keeps it read. The pin is the attention
   * signal; the bold was the old ruling's addition and is gone on both sides of the wire
   * (`mutations.ts#triage_set` overlay here, `TriageService.setState` on the server).
   */
  it("resurfacing a read message keeps its genuine read state", async () => {
    const { engine } = spyEngine();
    await engine.start();
    // Establish a genuine read first (deliberate, so the pinless row simply reads).
    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });
    expect(engine.read().get<EngineMessage>("message", "ben")!.unread).toBe(false);

    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });

    const m = engine.read().get<EngineMessage>("message", "ben")!;
    expect(m.unread, "the pin must not fabricate an unread").toBe(false);
    expect(m.lastReadAt, "the genuine reading is not disowned").not.toBeNull();
    expect(isResurfaced(m)).toBe(true);
    expect(pinnedIn(engine)).toEqual(["ben"]);
  });

  /**
   * …and an UNREAD row resurfaces unread — genuine state in the other direction, so this is not
   * a fix that quietly marks everything read.
   */
  it("resurfacing an unread message keeps it unread", async () => {
    const { engine } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    const m = engine.read().get<EngineMessage>("message", "ben")!;
    expect(m.unread).toBe(true);
    expect(pinnedIn(engine)).toEqual(["ben"]);
  });

  /**
   * THE STREAM GLANCE LANDS TOO. `feed_mark_seen` (the per-card dwell and the leave-commit in
   * Reads/Receipts) is a glance by construction; it used to drop pinned ids entirely, so
   * scrolling past a pinned row left its read state unstated. Now the read goes out per id with
   * the glance label and the pin stands.
   */
  it("a stream sweep reads a pinned row without spending the pin", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "f1", state: "resurfaced" });
    wire.length = 0;

    const res = await engine.mutate({
      kind: "feed_mark_seen",
      view: "reads",
      upToId: "f2",
      messageIds: ["f1", "f2"],
    });
    expect(res.status).toBe("confirmed");

    const bodies = new Map(patches(wire).map((c) => [c.url, c.body]));
    expect(bodies.get("https://api.test/messages/f1"), "the pinned row's read must reach the server")
      .toEqual({ unread: false, via: "glance" });
    expect(bodies.get("https://api.test/messages/f2")).toEqual({ unread: false, via: "glance" });

    const f1 = engine.read().get<EngineMessage>("message", "f1")!;
    expect(f1.unread).toBe(false);
    expect(isResurfaced(f1), "the stream glance must not spend the pin").toBe(true);
  });

  /**
   * THE GUARD THAT KEEPS THE FEATURE: a DELIBERATE read (no `via`) — the pill, `⇧I`, bulk,
   * read-all, the settled reply — still answers the pin. If the glance label ever leaked onto
   * the deliberate path, releasing a pin by reading would become impossible.
   */
  it("a deliberate read still spends the pin", async () => {
    const { engine, wire } = spyEngine();
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    wire.length = 0;

    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });

    expect(patches(wire)[0]!.body).toEqual({ ids: ["ben"], unread: false });
    expect(pinnedIn(engine)).toEqual([]);
    expect(engine.read().get<EngineMessage>("message", "ben")!.unread).toBe(false);
  });
});
