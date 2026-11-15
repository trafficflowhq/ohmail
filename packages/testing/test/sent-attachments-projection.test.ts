import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messages } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { FIXED_NOW, makeDeps, seedMessage, seedSession } from "../../api/test/helpers.js";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  HttpAdapter,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OPTIMISTIC_SENT_TTL_MS,
  SENT_FORWARD_MAX_PARTS,
  type EngineMessage,
  type FetchLike,
} from "@ohmail/client-engine";

/**
 * ═══ THE JUST-SENT MESSAGE SHOWS ITS ATTACHMENT — WITHOUT NAVIGATING AWAY AND BACK ═══════════
 *
 * The live repro this pins: send a mail with a picture, open it in Sent, and the attachment is
 * missing (or the strip claims the files could not load) until another message is opened and this
 * one re-opened. The seam is the optimistic Sent copy: `materializeSentOverlay` mints it under a
 * CLIENT id that exists on no server, so the reader's metadata read (`loadAttachments(copy.id)`)
 * can only 404 — a held failure over the exact bytes the engine was holding in the confirmed
 * mutation. The fix seeds the copy's attachment list from those bytes at materialize time, which
 * is the attachment-bearing update the open view (`useEngineNotice` → `attachmentsOf`) already
 * subscribes to.
 *
 * PROJECTION-LEVEL, deliberately: every assertion here reads what the strip renders from
 * (`attachmentsOf` — the synchronous render read) and what the pane's mount effect asks
 * (`loadAttachments`), against the REAL routes, so a regression that reintroduces the 404 window
 * goes red here without a browser.
 *
 * Mutation evidence (each watched red before being trusted):
 *  · drop the `seedSentAttachments` call in `materializeSentOverlay` → "the just-sent message's
 *    strip has no answer" fails (`loading`, the silent state) and the wire assertion fails with a
 *    real `GET /messages/<copy>/attachments`.
 *  · make `releaseAttachments` ignore the live seed → "a pane unmount dropped the seed" fails.
 *  · drop the `seed.live = false` retire in `reconcileOptimisticSent` → the freed-after-retire
 *    assertion fails (the list survives forever).
 */

const app = createApp(apiRoutes);

/** The delivered-mail spy from `mail-send.test.ts`, reduced to the confirm path this file drives. */
function makeSendSpy() {
  const delivered: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      delivered.push(msg);
      return { providerMessageId: msg.messageId ?? "<none>" };
    },
    async messageInSent() {
      return false;
    },
    async close() { /* nothing to tear down */ },
  });
  return { delivered, factory };
}

function bridgeFetch(deps: ApiDeps, token: string): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null });
  };
}

/** Deterministic object-URL minting/revocation WITHOUT replacing the URL class the harness needs. */
const urlGlobal = globalThis.URL as unknown as {
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
};
const originalCreate = urlGlobal.createObjectURL;
const originalRevoke = urlGlobal.revokeObjectURL;
let minted: Blob[] = [];
let revoked: string[] = [];
beforeEach(() => {
  minted = [];
  revoked = [];
  urlGlobal.createObjectURL = (b: Blob) => {
    minted.push(b);
    return `blob:seed-${minted.length}`;
  };
  urlGlobal.revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
});
afterEach(() => {
  urlGlobal.createObjectURL = originalCreate;
  urlGlobal.revokeObjectURL = originalRevoke;
});

const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const PHOTO_BASE64 = Buffer.from(PHOTO_BYTES).toString("base64");

async function world() {
  const spy = makeSendSpy();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: spy.factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const m = await seedMessage(db, {
    accountId: s.accountId,
    folder: "INBOX",
    subject: "Werkstatt-Besuch?",
    fromAddress: "lena@atelier.example",
  });
  await db.update(messages).set({ messageIdHeader: "<parent@atelier.example>" });

  const calls: string[] = [];
  const base = bridgeFetch(deps, s.token);
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return base(url, init);
  };

  // A mutable clock, so the TTL sweep can be driven without waiting ten minutes.
  const clock = { ms: FIXED_NOW.getTime() };
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }),
    store: new MemoryMirrorStore(),
    now: () => new Date(clock.ms),
  });
  const parent: EngineMessage = {
    id: m.id,
    accountId: s.accountId,
    mailboxId: m.mailboxId,
    threadId: null,
    messageIdHeader: "<parent@atelier.example>",
    subject: "Werkstatt-Besuch?",
    from: { name: "Lena", address: "lena@atelier.example" },
    to: [],
    cc: [],
    date: FIXED_NOW.toISOString(),
    folder: "INBOX",
    snippet: "…",
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: FIXED_NOW.toISOString(),
  };
  await engine.store.applyChanges([
    { type: "message", op: "create", id: parent.id, seq: 1, updatedAt: parent.updatedAt, entity: parent },
  ]);

  const sendWithPhoto = async () => {
    const res = await engine.mutate({
      kind: "mail_send",
      inReplyTo: null,
      mailboxId: parent.mailboxId,
      subject: "the photo",
      body: "see attached",
      to: [{ name: null, address: "dana@customer.example" }],
      attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", contentBase64: PHOTO_BASE64 }],
    });
    expect(res.status).toBe("confirmed");
    const copy = engine.read().list<EngineMessage>("message").find((x) => x.local === true);
    expect(copy, "no optimistic Sent copy was materialised on confirm").toBeTruthy();
    return copy!;
  };

  return { engine, calls, parent, clock, spy, sendWithPhoto };
}

/** The real Sent row a worker ingest would deliver, landing the copy's own header. */
async function landRealRow(w: Awaited<ReturnType<typeof world>>, copy: EngineMessage): Promise<void> {
  const real: EngineMessage = {
    ...w.parent,
    id: "real-sent-row",
    messageIdHeader: copy.messageIdHeader!.replace(/[<>]/g, ""),
    folder: "Sent Items" as EngineMessage["folder"],
    unread: false,
    from: { name: "me", address: "me@atelier.example" },
  };
  await w.engine.store.applyChanges([
    { type: "message", op: "create", id: real.id, seq: 999, updatedAt: real.updatedAt, entity: real },
  ]);
  await w.engine.syncOnce();
}

describe("the sent copy's attachments are in hand the moment the send confirms", () => {
  it("the open view's very next render shows the file — no navigation, no wire read", async () => {
    const w = await world();
    const copy = await w.sendWithPhoto();
    expect(copy.hasAttachments).toBe(true);
    expect(copy.attachmentCount).toBe(1);

    // WHAT THE STRIP RENDERS, synchronously, on the render the confirm's notify triggers.
    const view = w.engine.attachmentsOf(copy.id);
    expect(
      view.state,
      "the just-sent message's strip has no answer — the attachment is missing until navigation",
    ).toBe("ready");
    if (view.state !== "ready") return;
    expect(view.items).toHaveLength(1);
    const item = view.items[0]!;
    expect(item.filename).toBe("photo.jpg");
    expect(item.mimeType).toBe("image/jpeg");
    expect(item.sizeBytes).toBe(PHOTO_BYTES.length);
    // Fetched-in-advance: the bytes rode the send and are already held, so the tile is pressable
    // (save, preview) without a fetch against an id no server has.
    expect(item.state).toBe("ready");
    expect(item.objectUrl).toMatch(/^blob:/);
    const blob = w.engine.attachmentBlobOf(copy.id, item.id);
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PHOTO_BYTES);

    // THE PANE'S MOUNT EFFECT asks loadAttachments — answered from the held seed, with the
    // fabricated id never on the wire (a wire read against it can only 404).
    const outcome = await w.engine.loadAttachments(copy.id);
    expect(outcome.state).toBe("ready");
    expect(
      w.calls.some((c) => c.includes(`/messages/${copy.id}/attachments`)),
      "the copy's client-minted id was asked of the server — the read that can only 404",
    ).toBe(false);
  });

  it("a send with NO files seeds the empty list — no spurious failure over a fileless message", async () => {
    const w = await world();
    const res = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: w.parent.id,
      body: "no files on this one",
    });
    expect(res.status).toBe("confirmed");
    const copy = w.engine.read().list<EngineMessage>("message").find((x) => x.local === true)!;

    // `ready` with zero items renders as the ordinary nothing. Before the seed, the pane's
    // metadata read 404'd and the strip said "Couldn't load this message's files" over a
    // message that has none.
    const view = w.engine.attachmentsOf(copy.id);
    expect(view.state, "a just-sent fileless message drew the metadata 404 as a failure").toBe("ready");
    if (view.state === "ready") expect(view.items).toHaveLength(0);
    const outcome = await w.engine.loadAttachments(copy.id);
    expect(outcome.state).toBe("ready");
    expect(w.calls.some((c) => c.includes(`/messages/${copy.id}/attachments`))).toBe(false);
  });

  it("the seed survives a pane release while the copy stands — re-opening keeps the attachment", async () => {
    const w = await world();
    const copy = await w.sendWithPhoto();

    // The reader opens the copy, closes it (the pane's unmount cleanup releases), then re-opens.
    w.engine.releaseAttachments(copy.id);
    const view = w.engine.attachmentsOf(copy.id);
    expect(
      view.state,
      "a pane unmount dropped the seed while the copy still stands — re-opening the sent message loses its attachment again",
    ).toBe("ready");
    if (view.state === "ready") expect(view.items).toHaveLength(1);
  });

  it("once the real row lands, the ordinary release frees the seed's bytes", async () => {
    const w = await world();
    const copy = await w.sendWithPhoto();
    const url = (() => {
      const v = w.engine.attachmentsOf(copy.id);
      return v.state === "ready" ? v.items[0]!.objectUrl : undefined;
    })();
    expect(url).toBeTruthy();

    await landRealRow(w, copy);
    // The copy is retired; the reader that had it open moves on and the pane releases.
    w.engine.releaseAttachments(copy.id);

    expect(w.engine.attachmentsOf(copy.id).state, "the retired seed was never freed").toBe("loading");
    expect(revoked, "the seed's object URL leaked past its release").toContain(url);
  });

  it("a seed nobody opened is swept at the copy's own TTL", async () => {
    const w = await world();
    const copy = await w.sendWithPhoto();
    expect(w.engine.attachmentsOf(copy.id).state).toBe("ready");

    w.clock.ms += OPTIMISTIC_SENT_TTL_MS + 1;
    await w.engine.syncOnce(); // the drain runs the reconcile, which sweeps expired seeds

    expect(w.engine.attachmentsOf(copy.id).state, "the expired seed is still holding its bytes").toBe("loading");
  });
});

/**
 * ═══ A FORWARD'S SENT COPY LISTS THE INHERITED FILES TOO ════════════════════════════════════
 *
 * The delivered message of a forward carries MORE than the mutation did: the server streams the
 * original's parts onto the outgoing mail (`SendService.streamForwardOriginal`). A seed built from
 * `m.attachments` alone would publish a complete-looking `ready` list missing every inherited
 * file, for the copy's whole lifetime — the review finding on the first cut of this seam. So a
 * forward's copy is composed from the compose files PLUS the parent's own metadata list, under
 * the parent's REAL attachment ids (the byte route resolves an id alone, and the forward streamed
 * the same parts), and the copy's metadata reads delegate to the parent — the one id on this
 * subject a server can answer for.
 *
 * Driven against a model adapter rather than the API world: the subject is the ENGINE's
 * composition and delegation, and the model makes the parent's list — and its failure — exact.
 *
 * Mutation evidence: force `seedSentAttachments`'s no-forward branch for a `forwardOf` send
 * (publish `composeItems` as ready) — "the inherited file is missing from the just-forwarded
 * copy" fails in both the held and unheld cases.
 */
describe("a forward's sent copy — the inherited files ride the seed", () => {
  const PARENT_ID = "parent-msg-1";

  function forwardWorld(opts: { failParentList?: boolean; hangParentList?: boolean; partCount?: number } = {}) {
    const listCalls: string[] = [];
    const fetchCalls: string[] = [];
    const state = {
      failList: opts.failParentList === true,
      hangList: opts.hangParentList === true,
      /** When set, every byte fetch awaits it — how a test holds a fetch flight open. */
      fetchGate: null as Promise<void> | null,
    };
    const adapter = {
      sync: async () => ({ changes: [], cursor: "1", hasMore: false }),
      mutate: async () => ({ changes: [], seq: null, providerMessageId: "<fwd-1@x.example>" }),
      fetchBody: async () => null,
      listAttachments: async (id: string) => {
        listCalls.push(id);
        if (state.hangList) return new Promise<never>(() => { /* held open forever */ });
        if (state.failList) {
          throw new MutationRejectedError("the archive did not answer", {
            status: 500, code: "server_error", retryable: true,
          });
        }
        if (opts.partCount) {
          return Array.from({ length: opts.partCount }, (_, i) => ({
            id: `att-part-${i}`, filename: `part-${i}.pdf`, contentType: "application/pdf",
            sizeBytes: 10 + i, inline: false, messageId: id,
          }));
        }
        return [
          { id: "att-real-1", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 1234, inline: false, messageId: id },
          { id: "att-real-2", filename: "logo.png", contentType: "image/png", sizeBytes: 99, inline: true, contentId: "logo", messageId: id },
        ];
      },
      fetchAttachment: async (id: string) => {
        fetchCalls.push(id);
        if (state.fetchGate) await state.fetchGate;
        return new Blob(["x"], { type: "application/pdf" });
      },
    };
    const engine = new OhmailEngine({
      adapter: adapter as never,
      store: new MemoryMirrorStore(),
    });
    const parent: EngineMessage = {
      id: PARENT_ID,
      accountId: "acct-1",
      mailboxId: "mb-1",
      threadId: null,
      messageIdHeader: "<orig@x.example>",
      subject: "the invoice",
      from: { name: null, address: "vendor@x.example" },
      to: [],
      cc: [],
      date: FIXED_NOW.toISOString(),
      folder: "INBOX",
      snippet: "…",
      unread: false,
      hasAttachments: true,
      attachmentCount: 1,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: FIXED_NOW.toISOString(),
    };
    const ready = engine.store.applyChanges([
      { type: "message", op: "create", id: parent.id, seq: 1, updatedAt: parent.updatedAt, entity: parent },
    ]);
    const sendForward = async (forwardParts?: string[]) => {
      await ready;
      const res = await engine.mutate({
        kind: "mail_send",
        inReplyTo: null,
        forwardOf: PARENT_ID,
        ...(forwardParts ? { forwardParts } : {}),
        mailboxId: "mb-1",
        subject: "Fwd: the invoice",
        body: "see below",
        to: [{ name: null, address: "dana@customer.example" }],
        attachments: [{ filename: "note.txt", contentType: "text/plain", contentBase64: PHOTO_BASE64 }],
      });
      expect(res.status).toBe("confirmed");
      return engine.read().list<EngineMessage>("message").find((x) => x.local === true)!;
    };
    return { engine, listCalls, fetchCalls, state, sendForward };
  }

  it("with the parent's list in hand, the copy is complete the moment the send confirms", async () => {
    const w = forwardWorld();
    await w.engine.loadAttachments(PARENT_ID); // the forward was pressed on an open message
    const copy = await w.sendForward();

    const view = w.engine.attachmentsOf(copy.id);
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    // Files-only, the strip's default read: the composed note plus the inherited invoice.
    expect(
      view.items.map((i) => i.filename),
      "the inherited file is missing from the just-forwarded copy",
    ).toEqual(["note.txt", "invoice.pdf"]);
    // The inherited part rides under its REAL id, pressable through the ordinary byte route.
    expect(view.items[1]!.id).toBe("att-real-1");
    expect(view.items[1]!.state).toBe("idle");
    // The frameless reading asks for pictures too — the inline logo is there, not lost.
    const wide = w.engine.attachmentsOf(copy.id, { includeInlineParts: true });
    if (wide.state === "ready") expect(wide.items.map((i) => i.filename)).toContain("logo.png");
    // The copy's own paperclip counts the delivered files, not the mutation's.
    expect(copy.hasAttachments).toBe(true);
    expect(copy.attachmentCount).toBe(2);
    // The copy's client-minted id never reached the adapter.
    expect(w.listCalls).toEqual([PARENT_ID]);
  });

  it("without the parent's list, the copy composes from ONE read of the parent — never the fake id", async () => {
    const w = forwardWorld();
    const copy = await w.sendForward();

    // Before the parent answers, the copy publishes NOTHING (silent), never a confident subset.
    // (The seed fires the parent read itself; the pane's own mount effect delegates to the same.)
    const outcome = await w.engine.loadAttachments(copy.id);
    expect(outcome.state).toBe("ready");
    if (outcome.state !== "ready") return;
    expect(
      outcome.items.map((i) => i.filename),
      "the inherited file is missing from the just-forwarded copy",
    ).toEqual(["note.txt", "invoice.pdf"]);
    expect(w.listCalls.every((id) => id === PARENT_ID), "the copy's fake id was asked of the adapter").toBe(true);
  });

  it("a parent read that failed is carried as the copy's own failure, and Retry heals through the parent", async () => {
    const w = forwardWorld({ failParentList: true });
    const copy = await w.sendForward();

    const failed = await w.engine.loadAttachments(copy.id);
    expect(failed.state, "a failed parent read published a confident partial list").toBe("failed");
    if (failed.state === "failed") expect(failed.code).toBe("server_error");

    // The archive recovers; the strip's Retry re-asks the PARENT under the human-press rule.
    w.state.failList = false;
    const healed = await w.engine.loadAttachments(copy.id, { retry: true });
    expect(healed.state).toBe("ready");
    if (healed.state === "ready") {
      expect(healed.items.map((i) => i.filename)).toEqual(["note.txt", "invoice.pdf"]);
    }
    expect(w.listCalls.every((id) => id === PARENT_ID)).toBe(true);
  });

  /**
   * ══ THE SESSION-REVIVAL SEAM HEALS A DELEGATED FAILURE — release + plain re-load ══════════
   *
   * The shell's revival flow re-asks an auth-failed list by `releaseAttachments` then a plain
   * `loadAttachments` (no retry — the refusal's CAUSE is known gone). A live seed declines the
   * release, so without special care the carried parent failure was served back from memory and
   * the copy stayed failed until a manual Retry (review finding). The release now drops the
   * failed states on both ids — the seeded bytes stay — so the plain re-load is a fresh
   * question.
   *
   * Mutation: make the live-seed branch of `releaseAttachments` a bare `return`. Real failure
   * text:
   *   AssertionError: the revival's release+reload served the dead session's failure from
   *   memory: expected 'failed' to be 'ready'
   */
  it("release + plain re-load heals a carried failure — the revival seam's exact gesture", async () => {
    const w = forwardWorld({ failParentList: true });
    const copy = await w.sendForward();
    expect((await w.engine.loadAttachments(copy.id)).state).toBe("failed");

    // The session heals; the revival seam releases and re-asks WITHOUT retry.
    w.state.failList = false;
    w.engine.releaseAttachments(copy.id);
    const outcome = await w.engine.loadAttachments(copy.id);

    expect(
      outcome.state,
      "the revival's release+reload served the dead session's failure from memory",
    ).toBe("ready");
    if (outcome.state === "ready") {
      expect(outcome.items.map((i) => i.filename)).toEqual(["note.txt", "invoice.pdf"]);
    }
  });

  /**
   * ══ A PRESS ON THE COPY'S PART WORKS WHILE THE PARENT'S SAME PART IS IN FLIGHT ════════════
   *
   * The copy lists the parent's parts under their own ids, so the same id stands in two lists.
   * A byte flight keyed by the bare id handed the copy the PARENT's promise, whose completion
   * patches only the parent's list — the press on the copy silently moved nothing.
   *
   * Mutation: key `attachmentRequests` by `attachmentId` alone again. Real failure text:
   *   AssertionError: the copy's press rode the parent's flight and patched nothing: expected
   *   'idle' to be 'ready'
   */
  it("the same part fetched on parent and copy patches BOTH lists", async () => {
    const w = forwardWorld();
    await w.engine.loadAttachments(PARENT_ID);
    const copy = await w.sendForward();
    await w.engine.loadAttachments(copy.id);

    // Hold the byte route open and press the part on BOTH messages while it is held.
    let release!: () => void;
    w.state.fetchGate = new Promise<void>((resolve) => { release = resolve; });
    const onParent = w.engine.openAttachment(PARENT_ID, "att-real-1");
    const onCopy = w.engine.openAttachment(copy.id, "att-real-1");
    release();
    w.state.fetchGate = null;
    await Promise.all([onParent, onCopy]);

    const held = w.engine.attachmentsOf(copy.id);
    expect(held.state).toBe("ready");
    if (held.state !== "ready") return;
    const item = held.items.find((i) => i.id === "att-real-1")!;
    expect(
      item.state,
      "the copy's press rode the parent's flight and patched nothing",
    ).toBe("ready");
    expect(item.objectUrl).toMatch(/^blob:/);
  });

  /**
   * ══ THE PROJECTION CLAIMS AT MOST WHAT THE SEND STREAMED ══════════════════════════════════
   *
   * The send bounds a forward's inherited parts; the parent's metadata list does not. A
   * projection of the whole list onto a >cap original would name files the recipient never got.
   *
   * Mutation: drop the `slice(0, SENT_FORWARD_MAX_PARTS)`. Real failure text:
   *   AssertionError: the copy claims parts the send never streamed: expected 106 to be 101
   */
  it("a forward that named its parts lists only the parts it kept", async () => {
    const w = forwardWorld();
    await w.engine.loadAttachments(PARENT_ID);
    const copy = await w.sendForward(["att-real-2"]);
    const view = w.engine.attachmentsOf(copy.id, { includeInlineParts: true });
    expect(view.state === "ready" && view.items.map((i) => i.filename)).toEqual(["note.txt", "logo.png"]);
    expect(copy.attachmentCount).toBe(1);
    const none = forwardWorld();
    await none.engine.loadAttachments(PARENT_ID);
    const bare = await none.sendForward([]);
    const files = none.engine.attachmentsOf(bare.id, { includeInlineParts: true });
    expect(files.state === "ready" && files.items.map((i) => i.filename)).toEqual(["note.txt"]);
  });

  it("a forward of a >cap original lists at most the streamed subset", async () => {
    const w = forwardWorld({ partCount: SENT_FORWARD_MAX_PARTS + 5 });
    await w.engine.loadAttachments(PARENT_ID);
    const copy = await w.sendForward();

    const view = w.engine.attachmentsOf(copy.id, { includeInlineParts: true });
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect(
      view.items.length,
      "the copy claims parts the send never streamed",
    ).toBe(1 + SENT_FORWARD_MAX_PARTS); // the composed note + the streamed ceiling
  });

  /**
   * ══ TEARDOWN FREES A SEED WHOSE LIST WAS NEVER PUBLISHED ══════════════════════════════════
   *
   * A forward still waiting on its parent holds minted compose URLs with no `attachmentLists`
   * entry to find them under; a teardown that walks only list keys leaks them for the document's
   * life.
   *
   * Mutation: walk `attachmentLists.keys()` alone in `releaseAllAttachments`. Real failure
   * text:
   *   AssertionError: the unpublished seed's object URL survived the teardown: expected [] to
   *   include 'blob:seed-1'
   */
  it("releaseAllAttachments frees an unpublished forward seed's bytes", async () => {
    const w = forwardWorld({ hangParentList: true });
    const copy = await w.sendForward();
    // The parent read hangs, so the copy's list is unpublished — the silent state.
    expect(w.engine.attachmentsOf(copy.id).state).toBe("loading");
    const url = minted.length > 0 ? `blob:seed-${minted.length}` : undefined;
    expect(url, "the compose seed minted no URL to assert on").toBeTruthy();

    w.engine.releaseAllAttachments();

    expect(revoked, "the unpublished seed's object URL survived the teardown").toContain(url);
  });
});
