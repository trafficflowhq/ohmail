import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type EngineAdapter,
  type EngineMessage,
  type MessageBodyRecord,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE WITHHELD BODY IS ANSWERED, TERMINAL, AND HONEST ═══════════════════════════════════
 *
 * The server's storage cap created a state the client vocabulary could not say: a body row that
 * EXISTS and holds NO content by policy. Before the `withheld` marker, `bodyOf` reported that
 * record as `full` with `text: ""` — a blank pane claiming to be the whole message — because
 * "an empty body beside a populated snippet is not a state the pipeline produces" was true
 * right up until the cap produced it.
 *
 * Three properties, each with the failure it forecloses:
 *
 *  1. `state: "withheld"` with the SNIPPET as text — a real preview exists (the snippet is on
 *     the message row, deliberately outside the cap), and rendering nothing while holding it
 *     would waste the one thing the cap kept.
 *  2. TERMINAL — the record is `ready` underneath, so the single-flight ledger treats it as
 *     answered: no re-ask loop, no spinner, and no Retry (a retry cannot un-withhold).
 *  3. An ordinary empty body WITHOUT the marker keeps reporting `full` — the old decision
 *     stands wherever the server has not said otherwise, so a genuinely empty message still
 *     renders empty rather than falling back to a preview it claims is partial.
 *
 * Mutation watched: dropping the `withheld` carry from `fetchBodyInto`'s record (the engine
 * writes the record without the key) sends case 1 red with `state: "full"` — the exact lie the
 * marker ends.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");
let seq = 0;

function msg(id: string): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: "t1", messageIdHeader: null,
    id, subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date: "2026-08-21T09:00:00.000Z", folder: "INBOX",
    snippet: `snippet of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  } as EngineMessage;
}

async function seeded(ids: string[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    ids.map((id): SyncChange => ({
      type: "message", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: msg(id),
    })),
  );
  return store;
}

const QUIET = {
  sync: async (): Promise<SyncResponse> => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
  }),
  mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
};

const drain = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("a cap-withheld body on the wire", () => {
  it("hydrates to the TERMINAL `withheld` state, keeps the snippet, and is never re-asked", async () => {
    const store = await seeded(["m1"]);
    let asks = 0;
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => {
        asks += 1;
        // The husk, exactly as `getBody` serves it: empty text, no html, the marker.
        return { text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null, withheld: "storage_cap" as const };
      },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m1");
    await drain();

    const body = bodyOf(store, store.get<EngineMessage>("message", "m1")!);
    expect(body.state).toBe("withheld");
    // The snippet is the text — a real preview exists and is shown, never a blank pane.
    expect(body.text).toBe("snippet of m1");
    expect(body.html).toBeNull();

    // ANSWERED-TERMINAL: a second hydration finds a ready record and asks the server nothing.
    await engine.hydrateBody("m1");
    await drain();
    expect(asks).toBe(1);
  });

  it("an ordinary EMPTY body without the marker still reports `full` — the old decision stands", async () => {
    const store = await seeded(["m2"]);
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null }),
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m2");
    await drain();
    const body = bodyOf(store, store.get<EngineMessage>("message", "m2")!);
    expect(body.state).toBe("full");
    expect(body.text).toBe("");
    // The marker is written as `null`, not omitted — that is what makes the heal below terminate.
    expect(store.get<MessageBodyRecord>("message_body", "m2")!.withheld).toBeNull();
  });

  /**
   * MAIL 0065 WIDENED THE CLOSED SET, AND A MARKER THE MIRROR DROPS IS THE LIE COMING BACK.
   *
   * A spam verdict husks the hosted body under `junk_filed` (the bytes live on in the
   * provider's Junk); the reaper husks under `expunged`. A hydration path that recognises only
   * `storage_cap` narrows both to `withheld: null` — the record then claims an ordinary,
   * complete, empty body, permanently (`null` is ANSWERED, so nothing ever re-asks), which is
   * exactly the ambiguity the tri-state was built to end. Every marker the server can say must
   * hydrate as itself.
   */
  /**
   * THE RESTORE'S INVALIDATION SIGNAL (mail 0065, review round 2). A withheld husk is terminal
   * on the client — "ready", never re-asked — but the SERVER can refill it: a message restored
   * from the provider's Junk gets its bytes back and announces itself with a message change.
   * The store's body cascade sheds a cached WITHHELD record on any message change, so the next
   * open re-fetches the restored content; an ordinary ready body is untouched by the same
   * change, which is what keeps the cascade from turning every delta into a re-download.
   *
   * Mutation watched (restored, 2026-08-23): drop the withheld arm from `cascadeLocalDeletes`
   * ⇒ the first test red (the husk survives the update and the second open never re-asks).
   */
  it("a message change sheds a cached WITHHELD husk, and the next open re-asks", async () => {
    const store = await seeded(["m4"]);
    let asks = 0;
    let serve: "husk" | "restored" = "husk";
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => {
        asks += 1;
        return serve === "husk"
          ? { text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null, withheld: "junk_filed" as const }
          : { text: "the restored body", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null };
      },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m4");
    await drain();
    expect(bodyOf(store, store.get<EngineMessage>("message", "m4")!).state).toBe("withheld");

    // The server restores the message and the delta announces it.
    serve = "restored";
    await store.applyChanges([{
      type: "message", op: "update", id: "m4", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { ...msg("m4"), updatedAt: NOW.toISOString() },
    }]);
    expect(store.get("message_body", "m4")).toBeFalsy();   // tombstoned (entity null)
    await engine.hydrateBody("m4");
    await drain();
    expect(asks).toBe(2);
    const body = bodyOf(store, store.get<EngineMessage>("message", "m4")!);
    expect(body.state).toBe("full");
    expect(body.text).toBe("the restored body");
  });

  it("a REPLAYED (equal-seq) message change sheds nothing — idempotent apply holds", async () => {
    const store = await seeded(["m6"]);
    let asks = 0;
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => {
        asks += 1;
        return { text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null, withheld: "junk_filed" as const };
      },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    const update: SyncChange = {
      type: "message", op: "update", id: "m6", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { ...msg("m6"), updatedAt: NOW.toISOString() },
    };
    await store.applyChanges([update]);
    // The husk is cached AFTER the change landed…
    await engine.hydrateBody("m6");
    await drain();
    expect(bodyOf(store, store.get<EngineMessage>("message", "m6")!).state).toBe("withheld");
    // …and the SAME page replays (a re-read, an out-of-order stream): the seq guard rejects the
    // change, so the cascade must not act on it — a purge here would violate idempotent apply
    // and re-fetch a body nothing changed.
    await store.applyChanges([update]);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m6")!).state).toBe("withheld");
    await engine.hydrateBody("m6");
    await drain();
    expect(asks).toBe(1);
  });

  it("a storage_cap husk is shed by a message change too — the storage refill gives text back with one", async () => {
    const store = await seeded(["m7"]);
    let asks = 0;
    let serve: "husk" | "refilled" = "husk";
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => {
        asks += 1;
        return serve === "husk"
          ? { text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null, withheld: "storage_cap" as const }
          : { text: "the text that came back", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null };
      },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m7");
    await drain();
    expect(bodyOf(store, store.get<EngineMessage>("message", "m7")!).state).toBe("withheld");

    // The refill writes the text back and records the message's change.
    serve = "refilled";
    await store.applyChanges([{
      type: "message", op: "update", id: "m7", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { ...msg("m7"), updatedAt: NOW.toISOString() },
    }]);
    expect(store.get("message_body", "m7")).toBeFalsy();
    await engine.hydrateBody("m7");
    await drain();
    expect(asks).toBe(2);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m7")!).text).toBe("the text that came back");
  });

  it("an ordinary READY body survives the same message change — no re-download storm", async () => {
    const store = await seeded(["m5"]);
    let asks = 0;
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => {
        asks += 1;
        return { text: "an ordinary body", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null };
      },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m5");
    await drain();
    await store.applyChanges([{
      type: "message", op: "update", id: "m5", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { ...msg("m5"), updatedAt: NOW.toISOString() },
    }]);
    await engine.hydrateBody("m5");
    await drain();
    expect(asks).toBe(1);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m5")!).text).toBe("an ordinary body");
  });

  for (const marker of ["junk_filed", "expunged"] as const) {
    it(`a \`${marker}\` husk hydrates to the same terminal withheld state, marker carried`, async () => {
      const store = await seeded(["m3"]);
      const adapter: EngineAdapter = {
        ...QUIET,
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => ({
          text: "", html: null, loadedRemoteContent: false,
          unsubscribe: "no_header" as const, unsubscribeUrl: null, withheld: marker,
        }),
      };
      const engine = new OhmailEngine({ adapter, store, now: () => NOW });
      await engine.hydrateBody("m3");
      await drain();
      const body = bodyOf(store, store.get<EngineMessage>("message", "m3")!);
      expect(body.state).toBe("withheld");
      expect(body.text).toBe("snippet of m3");
      expect(store.get<MessageBodyRecord>("message_body", "m3")!.withheld).toBe(marker);
    });
  }
});

/**
 * ═══ THE ROLLING UPGRADE — A PRE-SLICE RECORD MUST NOT HIDE A WITHHELD BODY FOR EVER ═══════
 *
 * The defect: a tab already running pre-slice code fetches a body the server has just begun
 * withholding. That build does not know the wire field, so it persists
 * `{state: "ready", text: "", html: null}` — a shape indistinguishable from a genuinely empty
 * message. Reloaded into withheld-aware code, the hydration guard saw a `ready` record with an
 * `html` key and skipped for ever, so `bodyOf` reported `full` over nothing and the marker was
 * defeated permanently for every browser that was open across the deploy. Nothing could heal it,
 * because absence of `withheld` meant both "not withheld" and "never asked by a build that could
 * tell".
 *
 * The fix is a tri-state: both write sites now ALWAYS set the key, so `undefined` means only
 * "no withheld-aware build has answered for this record" and one re-ask closes it for good.
 *
 * These three tests are the ruling's own, and the cost one is not optional: the docblock at the
 * guard forbids turning a plain-text mail into a poll, and the narrow `text === "" && html ===
 * null` predicate is the only thing standing between the heal and exactly that.
 */
describe("a body record written before the withheld marker existed", () => {
  /** Plant the pre-slice shape directly — no build in this repo can still produce it. */
  async function withPreSliceRecord(id: string, text: string): Promise<MemoryMirrorStore> {
    const store = await seeded([id]);
    // No `withheld` key at all — the shape a pre-slice build wrote. `putLocal` is the same seam
    // `body-enqueue-heal.test.ts` uses to plant older record shapes.
    await store.putLocal("message_body", id, { messageId: id, state: "ready", text, html: null });
    return store;
  }

  it("is re-asked EXACTLY ONCE, learns the marker, and is never asked again", async () => {
    const store = await withPreSliceRecord("m3", "");
    let asks = 0;
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => {
        asks += 1;
        return { text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null, withheld: "storage_cap" as const };
      },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m3");
    await drain();

    // ONE ask — the count, not just the outcome, because a heal that loops is the failure mode.
    expect(asks).toBe(1);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m3")!).state).toBe("withheld");
    // The record now CARRIES the key. Without this the write is still a conditional spread and
    // the record would be re-asked once per session for ever — built, tested, and unreachable.
    expect(store.get<MessageBodyRecord>("message_body", "m3")!.withheld).toBe("storage_cap");

    // A SECOND ENGINE over the same mirror — a reload — must ask nothing at all.
    const engine2 = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine2.hydrateBody("m3");
    await drain();
    expect(asks, "the heal is once EVER, not once per reload").toBe(1);
  });

  it("a PLAIN-TEXT pre-slice record is never re-asked — the cost rule holds", async () => {
    const store = await withPreSliceRecord("m4", "the whole message, in plain text");
    let asks = 0;
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => { asks += 1; return { text: "x", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null }; },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m4");
    await drain();
    // `html: null` beside real text is the ordinary plain-text mail the guard's docblock protects.
    expect(asks, "a plain-text body must not become a billed poll").toBe(0);
  });

  it("heals to `full` when the body was merely empty, and still stops", async () => {
    const store = await withPreSliceRecord("m5", "");
    let asks = 0;
    const adapter: EngineAdapter = {
      ...QUIET,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => { asks += 1; return { text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null }; },
    };
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m5");
    await drain();
    expect(asks).toBe(1);
    // Answered, not withheld: the key is written as `null`, so the record leaves the branch.
    expect(store.get<MessageBodyRecord>("message_body", "m5")!.withheld).toBeNull();
    expect(bodyOf(store, store.get<EngineMessage>("message", "m5")!).state).toBe("full");
    await engine.hydrateBody("m5");
    await drain();
    expect(asks).toBe(1);
  });
});

/**
 * ═══ A STORAGE-CAP RECORD FROM BEFORE THE REFILL ════════════════════════════════════════════
 *
 * An older build kept a `storage_cap` husk through every message change, so a letter whose text the
 * storage refill brought back while that build ran still opens empty after the upgrade. Such a
 * record carries no stamp: it is asked once more, and the answer is stamped, so a reload asks
 * nothing.
 */
describe("a storage_cap record written before the refill existed", () => {
  async function withOlderCapRecord(id: string): Promise<MemoryMirrorStore> {
    const store = await seeded([id]);
    await store.putLocal("message_body", id, {
      messageId: id, state: "ready", text: "", html: null, loadedRemoteContent: false,
      unsubscribe: "no_header", unsubscribeUrl: null, withheld: "storage_cap",
    });
    return store;
  }
  const capAdapter = (answer: () => Record<string, unknown>, asked: { n: number }): EngineAdapter => ({
    ...QUIET,
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => { asked.n += 1; return answer() as never; },
  });

  it("opens with the text that came back meanwhile", async () => {
    const store = await withOlderCapRecord("m9");
    const asked = { n: 0 };
    const engine = new OhmailEngine({
      adapter: capAdapter(() => ({ text: "back from the mail server", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }), asked),
      store, now: () => NOW,
    });
    await engine.hydrateBody("m9");
    await drain();
    expect(asked.n).toBe(1);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m9")!).text).toBe("back from the mail server");
  });

  it("is asked once ever: a husk still empty is not asked again, in this engine or the next", async () => {
    const store = await withOlderCapRecord("m10");
    const asked = { n: 0 };
    const adapter = capAdapter(() => ({
      text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null, withheld: "storage_cap",
    }), asked);
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m10");
    await drain();
    await engine.hydrateBody("m10");
    await drain();
    expect(asked.n).toBe(1);
    const engine2 = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine2.hydrateBody("m10");
    await drain();
    expect(asked.n, "the re-ask is once ever, not once per reload").toBe(1);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m10")!).state).toBe("withheld");
  });
});
