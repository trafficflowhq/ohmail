import type { EngineMessage, MessageBodyRecord, MutationOutcome, SensitivityFlags } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  SearchIndex,
  isProtectedMessage,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE READER ALWAYS SEES THEIR OWN BODY — SENSITIVE MAIL INCLUDED (item 1) ═══════════════
 *
 * Body withholding at rest is removed. A message flagged sensitive is treated no differently from
 * any other for caching, hydrating and indexing its body on the client: the mail already sits in
 * full on the reader's own server, so refusing to show or cache the copy in the app only hid it
 * from the one person entitled to read it — and the detector that drove it over-fired. So
 * `isProtectedMessage` is now a constant `false`, and the guards below pin the consequence: a
 * sensitive body is FETCHED, CACHED, and never purged on a sensitivity transition.
 *
 * ── WHAT "SEARCHABLE" MEANS HERE SINCE THAT CHANGE ──────────────────────────────────
 *
 * The instant index no longer reads ANY body — the archive is the body search — so this file's
 * fourth claim moved: a sensitive body is not in the instant index, and neither is an ordinary
 * one. "Like any other" is the claim, and it is now asserted as a PAIR in every case that makes
 * it: the sensitive row and an ordinary twin, side by side, answering identically. That is the
 * shape that would catch the thing this slice exists to prevent — a body gate that singles out
 * mail somebody's detector called sensitive — coming back in the index instead of in the cache.
 *
 * (The disclosure gate to a MODEL is untouched and lives elsewhere — `no_ai`/`no_kb` on the DTO,
 * and the server-side `redactForModel`. None of that is on this client path.)
 */

const NOW = new Date("2026-08-05T12:00:00.000Z");
let seq = 0;

const SENSITIVE: SensitivityFlags = {
  sensitive: true, category: "verification", no_ai: true, no_forward: true, no_kb: true, priority: false,
};
const ORDINARY: SensitivityFlags = {
  sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
};

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: "bank@example.test" },
    to: [],
    cc: [],
    date: "2026-08-05T09:00:00.000Z",
    folder: "INBOX",
    snippet: "redactedpreview only",
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: ORDINARY,
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** A quiet `/sync` plus a scriptable body endpoint carrying a distinctive secret token. */
function adapterOf(body: (id: string) => Promise<{ text: string } | null>): EngineAdapter & { bodyCalls: string[] } {
  const bodyCalls: string[] = [];
  return {
    bodyCalls,
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0",
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id) => {
      bodyCalls.push(id);
      return body(id);
    },
  } as unknown as EngineAdapter & { bodyCalls: string[] };
}

async function engineWith(
  messages: EngineMessage[],
  body: (id: string) => Promise<{ text: string } | null> = async () => ({ text: "quokkaledger secret payload" }),
): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore; adapter: { bodyCalls: string[] } }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    messages.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  const adapter = adapterOf(body);
  const engine = new OhmailEngine({ adapter, store, now: () => NOW });
  return { engine, store, adapter };
}

/** The message DTO shape a real `message`/update carries when the redaction pass marks it. */
function protect(before: EngineMessage): EngineMessage {
  return { ...before, sensitivity: SENSITIVE, snippet: "redactedpreview only", unread: false };
}

describe("the predicate is a constant false — no body is withheld from the reader", () => {
  it("returns false for an ordinary message, a wire-sensitive one, and a fixture-protected one", () => {
    // Mutation: restore `return m.sensitivity?.sensitive === true` in `isProtectedMessage` and the
    // second assertion goes red — which is exactly the body-hiding this slice removed.
    expect(isProtectedMessage(msg({ id: "a" }))).toBe(false);
    expect(isProtectedMessage(msg({ id: "b", sensitivity: SENSITIVE }))).toBe(false);
    expect(isProtectedMessage({ sensitivity: ORDINARY, protected: { label: "OTP" } })).toBe(false);
    expect(isProtectedMessage(undefined)).toBe(false);
  });
});

describe("a sensitive message's body is fetched and cached — like any other", () => {
  it("hydrateBody fetches a sensitive message's body and caches it, exactly as for an ordinary one", async () => {
    // The reader is entitled to their own code. Mutation: re-add the `if (isProtectedMessage(msg))`
    // short-circuit to `hydrateBody` (returning without fetching) ⇒ bodyCalls is empty and no
    // record is written, which is the eternal-spinner defect this removes.
    const { engine, store, adapter } = await engineWith([
      msg({ id: "otp", sensitivity: SENSITIVE }),
      msg({ id: "plain" }),
    ]);
    await engine.hydrateBody("otp");
    await engine.hydrateBody("plain");
    expect(adapter.bodyCalls).toEqual(["otp", "plain"]);
    expect(store.get<MessageBodyRecord>("message_body", "otp")?.text).toContain("quokkaledger");
    expect(store.get<MessageBodyRecord>("message_body", "plain")?.text).toContain("quokkaledger");
    // THE PAIR. Neither is in the instant index, and the sensitive one is not singled out —
    // which is the claim. Both are archive questions now.
    expect(engine.search("quokkaledger").items).toHaveLength(0);
    // …and the message rows themselves are indexed, both of them: this is an index that skips
    // bodies, not one that skips sensitive mail.
    expect(engine.search("redactedpreview").items.map((h) => h.message.id).sort()).toEqual(["otp", "plain"]);
  });

  it("a message that BECOMES sensitive KEEPS its cached body and search entry", async () => {
    // The reverse of the old purge: a sensitivity transition no longer sheds the body. Mutation:
    // re-add the protect branch to `cascadeLocalDeletes` (`ch.op !== "delete" &&
    // !isProtectedMessage(...)`) ⇒ the body is purged on the update and this goes red.
    const { engine, store } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    expect(store.get<MessageBodyRecord>("message_body", "m1")?.text).toContain("quokkaledger");

    const before = store.get<EngineMessage>("message", "m1")!;
    await store.applyChanges([{
      type: "message", op: "update", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: protect(before),
    }]);

    const after = store.get<EngineMessage>("message", "m1");
    expect(after!.sensitivity.sensitive).toBe(true);   // the LABEL still flips
    // …but the body stays on the device, which is what the purge used to take.
    expect(store.get<MessageBodyRecord>("message_body", "m1")?.text).toContain("quokkaledger");
    // The message is still in the instant index after the transition — the row is not dropped
    // for being sensitive. Its BODY is in no index, before or after, like every other body.
    expect(engine.search("redactedpreview").items.map((h) => h.message.id)).toEqual(["m1"]);
  });
});

describe("engine load leaves a sensitive message's cached body in place", () => {
  it("hydrate() does NOT purge a sensitive body, and the row stays in the index", async () => {
    // Mutation: re-add a `purgeProtectedBodies()` sweep to `hydrate()` that keys on the old
    // predicate ⇒ this body vanishes and `quokkaledger` stops matching.
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: msg({ id: "m1", sensitivity: SENSITIVE }),
    }]);
    await store.putLocal("message_body", "m1", {
      messageId: "m1", state: "ready", text: "quokkaledger secret payload", html: null, loadedRemoteContent: false,
    } satisfies MessageBodyRecord);

    const engine = new OhmailEngine({ adapter: adapterOf(async () => null), store, now: () => NOW });
    await engine.hydrate();

    expect(store.get<MessageBodyRecord>("message_body", "m1")?.text).toContain("quokkaledger");
    expect(engine.search("redactedpreview").items.map((h) => h.message.id)).toEqual(["m1"]);
  });
});

describe("the search index treats a sensitive body exactly like an ordinary one", () => {
  it("indexes NEITHER, and reports both rows the same way", async () => {
    /*
     * THE PAIR IS THE ASSERTION. A later fix took every body out of the instant index, so an
     * absence for the sensitive row proves nothing on its own — an index that had re-grown a
     * sensitivity gate would give exactly the same absence. The ordinary twin is what separates
     * "no body is indexed" from "this body is not indexed", and the twin differs from the
     * sensitive row in its `sensitivity` flags and in nothing else.
     *
     * Mutation A: re-add a body pass to `SearchIndex.build` ⇒ both rows match `quokkaledger`
     * and this goes red. Mutation B: re-add the body pass WITH an `isProtectedMessage` gate ⇒
     * the ordinary row matches and the sensitive one does not, which is the defect this file
     * exists for, and the pair catches it where a single row could not.
     */
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      {
        type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(),
        entity: msg({ id: "m1", sensitivity: SENSITIVE }),
      },
      {
        type: "message", op: "create", id: "m2", seq: ++seq, updatedAt: NOW.toISOString(),
        entity: msg({ id: "m2" }),
      },
    ]);
    for (const id of ["m1", "m2"]) {
      await store.putLocal("message_body", id, {
        messageId: id, state: "ready", text: "quokkaledger secret payload", html: null, loadedRemoteContent: false,
      } satisfies MessageBodyRecord);
    }

    const idx = SearchIndex.build(store);
    expect(idx.search("quokkaledger").items).toHaveLength(0);
    expect(idx.coverage()).toEqual({ messages: 2, full: 0 });
    // The positive control: both rows ARE in the index, by everything that is not a body.
    expect(idx.search("redactedpreview").items.map((h) => h.message.id).sort()).toEqual(["m1", "m2"]);
  });
});
