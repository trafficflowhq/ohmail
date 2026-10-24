import { describe, expect, it } from "vitest";
import { attachments, drafts, messages, outboundSends } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { FIXED_NOW, makeDeps, seedBody, seedMailbox, seedMessage, seedSession, seedThread } from "../../api/test/helpers.js";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  draftsList,
  HttpAdapter,
  isForwardedByUs,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  replySubject,
  threadOf,
  type EngineDraft,
  type EngineMessage,
  type FetchLike,
} from "@ohmail/client-engine";

/**
 * SENDING A REPLY, END TO END THROUGH THE REAL BACKEND.
 *
 * The engine's `mail_send` verb against `createApp(apiRoutes)` in-process: the SAME
 * `DraftsService` + `SendService` + router the deployed API runs, over PGlite, with the
 * SMTP/IMAP seam replaced by an injected `sendAdapter` spy — the seam production fills with
 * `makeSendAdapter` (decrypted creds → a connected `ImapAdapter` that SMTPs and APPENDs to
 * Sent). What is faked here is the transport and nothing above it.
 *
 * THE ASSERTION THAT MATTERS is `spy.delivered.length`. A reply is two requests and only the
 * second is idempotent server-side, so every retry path in this file exists to answer one
 * question: did the recipient get the mail twice? Each of those assertions was watched to
 * fail before it was trusted — see the mutation table in the slice report.
 *
 * NO REAL MAIL LEAVES THIS FILE. The spy never opens a socket, and the root
 * `test/setup/no-external-network.ts` hook would fail the run if anything tried.
 */

const app = createApp(apiRoutes);

interface SendSpy {
  delivered: OutboundMessage[];
  probes: string[];
  /** Which mailbox each adapter was opened for — the SMTP dial and the Sent append are both its. */
  opened: string[];
  /** Make `send` throw (SMTP ambiguity); the service then probes Sent. */
  throwOnSend: boolean;
  /** What the Sent-folder probe answers. `false` + `throwOnSend` ⇒ `unverified`. */
  foundInSent: boolean;
  factory: OpenSendAdapter;
}

function makeSendSpy(): SendSpy {
  const spy: SendSpy = {
    delivered: [],
    probes: [],
    opened: [],
    throwOnSend: false,
    foundInSent: false,
    factory: async (mailboxId: string) => {
      spy.opened.push(mailboxId);
      return {
        async send(msg: OutboundMessage) {
          if (spy.throwOnSend) throw new Error("SMTP 451 — try again later");
          spy.delivered.push(msg);
          return { providerMessageId: msg.messageId ?? "<none>" };
        },
        async messageInSent(id: string) {
          spy.probes.push(id);
          return spy.foundInSent;
        },
        async close() { /* nothing to tear down */ },
      };
    },
  };
  return spy;
}

/** Bridge the adapter's injectable fetch into the in-process app as a bearer client. */
function bridgeFetch(deps: ApiDeps, token: string): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null });
  };
}

/**
 * A signed-in account holding ONE inbox message, with that message already in the engine's
 * mirror. The mirror is seeded directly rather than drained, because `/sync` surfaces a
 * message only once something has emitted a change for it and the subject here is the reply,
 * not the delta feed (`contract.test.ts` owns that).
 */
async function world(opts: { subject?: string } = {}) {
  const spy = makeSendSpy();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: spy.factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const m = await seedMessage(db, {
    accountId: s.accountId,
    folder: "INBOX",
    subject: opts.subject ?? "Werkstatt-Besuch?",
    fromAddress: "lena@atelier.example",
  });
  // THREADING COMES FROM THE STORED HEADER, NOT FROM THE CLIENT. `SendService.reserve` reads
  // `messages.message_id_header` for `In-Reply-To`/`References` (send-service.ts:194-208), and
  // `seedMessage` leaves it null — with it null the reply carries no threading headers at all
  // and every correspondent's client starts a new conversation. Set it, because a reply whose
  // threading silently vanishes is exactly the failure this file should notice.
  await db.update(messages).set({ messageIdHeader: "<parent@atelier.example>" });
  // A forwardable original has a STORED body; the send refuses one without (an empty quote is
  // the empty mail a forward fix measured), so the world seeds what ingest writes.
  await seedBody(db, { messageId: m.id, text: "Kommst du am Freitag in die Werkstatt?" });

  const calls: string[] = [];
  const base = bridgeFetch(deps, s.token);
  /**
   * The transport fault injector. It is handed the REAL call as `pass` so a test can let the
   * server commit and then lose the answer — the failure mode the draft memo cannot close,
   * and the only one where composing a reply from two requests costs anything.
   */
  type Intercept = (url: string, pass: () => Promise<Response>) => Promise<Response> | null;
  let intercept: Intercept | null = null;
  const sendBodies: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (new URL(url).pathname.endsWith("/send")) sendBodies.push(String(init?.body ?? ""));
    const pass = (): Promise<Response> => base(url, init);
    return intercept?.(url, pass) ?? pass();
  };

  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }),
    store: new MemoryMirrorStore(),
  });
  const parent: EngineMessage = {
    id: m.id,
    accountId: s.accountId,
    mailboxId: m.mailboxId,
    threadId: null,
    messageIdHeader: "<parent@atelier.example>",
    subject: opts.subject ?? "Werkstatt-Besuch?",
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

  return {
    db, deps, spy, engine, calls, parent, sendBodies,
    accountId: s.accountId,
    setIntercept: (fn: Intercept | null) => { intercept = fn; },
  };
}

describe("mail_send — the client half of the gated send", () => {
  it("delivers over the real routes: one draft, one reservation, one delivery", async () => {
    const w = await world();

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne — Donnerstag?" });

    expect(res.status).toBe("confirmed");

    // ONE delivery, addressed and threaded from the parent.
    expect(w.spy.delivered).toHaveLength(1);
    expect(w.spy.delivered[0]!.to).toEqual(["lena@atelier.example"]);
    expect(w.spy.delivered[0]!.subject).toBe("Re: Werkstatt-Besuch?");
    expect(w.spy.delivered[0]!.text).toBe("Gerne — Donnerstag?");
    expect(w.spy.delivered[0]!.inReplyTo).toBe("<parent@atelier.example>");
    // The minted id is what SendService reserved, not one the transport invented.
    expect(w.spy.delivered[0]!.messageId).toMatch(/^<.+@.+>$/);

    // The server-side state machine really finalized.
    const rows = await w.db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.inReplyToMessageId).toBe(w.parent.id);
    const sends = await w.db.select().from(outboundSends);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.status).toBe("sent");
    expect(sends[0]!.providerMessageId).toBe(w.spy.delivered[0]!.messageId);

    // Two requests, in this order, and no third.
    expect(w.calls.filter((c) => c.startsWith("POST"))).toEqual([
      "POST /drafts",
      `POST /drafts/${rows[0]!.id}/send`,
    ]);
  });

  it("a COMPOSE with Cc and Bcc delivers all three, and the stored draft keeps them", async () => {
    // The whole thread in one send: mutation → `POST /drafts` (with cc+bcc) → `DraftsService`
    // stores them → the created DTO echoes `bcc` so the version-skew guard passes → `POST
    // /drafts/:id/send` → `SendService` builds an `OutboundMessage` carrying cc+bcc. The
    // header/envelope asymmetry that keeps bcc blind is asserted one layer down against the MIME
    // builder (`packages/core/test/outbound-cc-bcc.test.ts`); here the claim is that nothing on the
    // client→service path DROPS the bcc, which is exactly what used to happen.
    const w = await world();

    const res = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: null,                       // a fresh compose, not a reply
      mailboxId: w.parent.mailboxId,
      subject: "quarterly numbers",
      body: "see attached",
      to: [{ name: null, address: "to@example.test" }],
      cc: [{ name: "Cee", address: "cc@example.test" }],
      bcc: [{ name: null, address: "blind@example.test" }],
    });
    expect(res.status).toBe("confirmed");

    expect(w.spy.delivered).toHaveLength(1);
    const msg = w.spy.delivered[0]!;
    expect(msg.to).toEqual(["to@example.test"]);
    expect(msg.cc).toEqual(["cc@example.test"]);
    expect(msg.bcc).toEqual(["blind@example.test"]);

    // Stored on the row, because the send is a second request that reads it back.
    const rows = await w.db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cc).toEqual([{ name: "Cee", address: "cc@example.test" }]);
    expect(rows[0]!.bcc).toEqual([{ name: null, address: "blind@example.test" }]);
  });

  /**
   * ══ ONE ROW, FIRST KEYSTROKE TO DELIVERY ═══════════════════════════════════════════════
   *
   * The compose form autosaves through `draft_save`, so by the time Send is pressed the account
   * already holds this message as a `drafts` row. The send must USE that row. Before this, every
   * send did its own `POST /drafts` unconditionally — so an autosaved compose would have left a
   * `draft` row behind for every message it sent, sitting in the Drafts list, next to a copy of
   * the mail that had already gone.
   *
   * The assertion is a COUNT OF ROWS in the real database, not a count of requests: a request
   * count would be satisfied by a create the service happened to de-duplicate, and what is
   * claimed here is about what the account is left holding.
   *
   * Mutation: drop the `?? m.draftId` from `mailSend`'s `draftId` resolution. Real failure text:
   *   AssertionError: sending an autosaved compose left a second draft row behind: expected 2
   *   to be 1
   */
  it("a send REUSES the autosaved row instead of creating a second one", async () => {
    const w = await world();

    // The autosave, exactly as the compose form makes it.
    const saved = await w.engine.mutate({
      kind: "draft_save",
      draftId: null,
      mailboxId: w.parent.mailboxId,
      subject: "quarterly numbers",
      body: "half a sentence",
      to: [{ name: null, address: "to@example.test" }],
      cc: [],
      bcc: [],
    });
    expect(saved.status).toBe("confirmed");
    // The server's own id came back, which is the whole mechanism.
    expect(saved.entityId, "the create did not report the row's id").toBeTruthy();
    const rowsAfterSave = await w.db.select().from(drafts);
    expect(rowsAfterSave).toHaveLength(1);
    expect(rowsAfterSave[0]!.id).toBe(saved.entityId);
    expect(rowsAfterSave[0]!.status).toBe("draft");

    // …and then Send, naming it.
    const sentRes = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: null,
      draftId: saved.entityId!,
      mailboxId: w.parent.mailboxId,
      subject: "quarterly numbers",
      body: "the whole sentence, finished",
      to: [{ name: null, address: "to@example.test" }],
      cc: [],
      bcc: [],
    });
    expect(sentRes.status).toBe("confirmed");

    const rows = await w.db.select().from(drafts);
    expect(rows.length, "sending an autosaved compose left a second draft row behind").toBe(1);
    expect(rows[0]!.id).toBe(saved.entityId);
    expect(rows[0]!.status).toBe("sent");

    // THE LAST TWO SECONDS OF TYPING WENT OUT. The debounce means the row is up to a pause
    // behind the screen, so the send PUTs the mutation's own fields before it delivers —
    // otherwise the message delivered is not the message the sender was looking at.
    expect(w.spy.delivered).toHaveLength(1);
    expect(w.spy.delivered[0]!.text, "the send delivered the STALE stored body")
      .toBe("the whole sentence, finished");
    expect(rows[0]!.body).toBe("the whole sentence, finished");
  });

  /**
   * THE SEND LEAVES FROM THE MAILBOX ON SCREEN AT PRESS TIME — not the one the row froze at
   * its first autosave.
   *
   * The failure this pins: a compose autosaves at the first keystroke, which creates the row
   * under whatever the From picker held THEN. Picking a different From afterwards (or the
   * domain-match switch, which can only fire after recipients exist — i.e. after the row) used
   * to change the screen and nothing else: the pre-send PUT carried no `mailboxId`, the server
   * refused to move the column anyway, and `SendService` dialed the ROW's mailbox. A message
   * composed as one identity left as another.
   *
   * Now the mutation's `mailboxId` — the resolution the From line rendered — rides the pre-send
   * PUT, the row is re-homed while still `draft`, and the reservation, the SMTP dial and the
   * Sent append are all the picked mailbox's. Asserted at every layer the identity touches:
   * the adapter the service OPENED (dial + Sent append), the envelope's `from`, the minted
   * Message-ID's domain, and the stored row.
   */
  it("the send uses the mailbox picked at press time, not the one the draft was created under", async () => {
    const w = await world();
    const other = await seedMailbox(w.db, {
      accountId: w.accountId, address: "second-identity@elsewhere.example",
    });

    // Autosave under the FIRST mailbox — the row is born here, before any pick.
    const saved = await w.engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: w.parent.mailboxId,
      subject: "from the right address", body: "half",
      to: [{ name: null, address: "dana@customer.example" }], cc: [], bcc: [],
    });
    expect(saved.status).toBe("confirmed");

    // Send with the OTHER mailbox picked — what the From selector resolved at press time.
    const sent = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, draftId: saved.entityId!, mailboxId: other,
      subject: "from the right address", body: "the whole message",
      to: [{ name: null, address: "dana@customer.example" }], cc: [], bcc: [],
    });
    expect(sent.status).toBe("confirmed");

    // The dial and the Sent append: the adapter was opened for the PICKED mailbox.
    expect(w.spy.opened, "the send dialed the frozen mailbox, not the picked one").toEqual([other]);
    // The envelope: the From is the picked identity's address.
    expect(w.spy.delivered).toHaveLength(1);
    expect(w.spy.delivered[0]!.from).toBe("second-identity@elsewhere.example");
    // The minted Message-ID: its domain is the picked identity's.
    expect(w.spy.delivered[0]!.messageId).toMatch(/@elsewhere\.example>$/);
    // The row: re-homed, one row, sent.
    const rows = await w.db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mailboxId).toBe(other);
    expect(rows[0]!.status).toBe("sent");
  });

  /**
   * AN `unverified` SEND IS FINDABLE AFTERWARDS. SMTP threw AND the Sent probe found nothing:
   * the text is in the row, the row is `unverified`, and `draftsList` — the one selector every
   * Drafts surface reads — must list it. Before this, the list filtered to `status === "draft"`
   * and an undelivered message's only copy was invisible on every surface.
   */
  it("an unverified send stays findable: draftsList lists the row after the drain", async () => {
    const w = await world();
    const saved = await w.engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: w.parent.mailboxId,
      subject: "did this go?", body: "the only copy of this text",
      to: [{ name: null, address: "nobody@no-mx.example" }], cc: [], bcc: [],
    });
    w.spy.throwOnSend = true;
    w.spy.foundInSent = false;

    const res = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, draftId: saved.entityId!, mailboxId: w.parent.mailboxId,
      subject: "did this go?", body: "the only copy of this text",
      to: [{ name: null, address: "nobody@no-mx.example" }], cc: [], bcc: [],
    });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("send_unverified");

    // The server finalized the row `unverified` and emitted the change; drain it in.
    await w.engine.syncOnce();
    const listed = draftsList(w.engine.read(), FIXED_NOW);
    const row = listed.find((d) => d.id === saved.entityId);
    expect(row, "the unverified send is invisible in the drafts list").toBeDefined();
    expect(row!.status).toBe("unverified");
    expect(row!.body).toBe("the only copy of this text");
  });

  /**
   * AUTOSAVE UPDATES THE SAME ROW, however long somebody types. The engine half of the
   * one-row rule; the surface half is in `apps/webapp/test/compose-autosave.test.tsx`.
   */
  it("draft_save creates once and then updates, against the real routes", async () => {
    const w = await world();
    const first = await w.engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: w.parent.mailboxId,
      subject: "one", body: "a", to: [], cc: [], bcc: [],
    });
    const second = await w.engine.mutate({
      kind: "draft_save", draftId: first.entityId!,
      subject: "two", body: "ab", to: [], cc: [], bcc: [],
    });
    expect(second.status).toBe("confirmed");

    const rows = await w.db.select().from(drafts);
    expect(rows.length, "a second draft row was created instead of updating the first").toBe(1);
    expect(rows[0]!.subject).toBe("two");
    expect(rows[0]!.body).toBe("ab");
    expect(rows[0]!.status).toBe("draft");
    expect(w.calls.filter((c) => c.startsWith("POST /drafts"))).toHaveLength(1);
    expect(w.calls.filter((c) => c.startsWith("PUT /drafts"))).toHaveLength(1);
  });

  /**
   * DISCARD REALLY DELETES IT, and a discard of something already gone is not an error — the
   * user asked for the draft to be gone and it is gone (`rule_delete`'s 404 reasoning).
   */
  it("draft_discard removes the row, and a second discard is not a failure", async () => {
    const w = await world();
    const made = await w.engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: w.parent.mailboxId,
      subject: "throwaway", body: "x", to: [], cc: [], bcc: [],
    });
    expect(await w.db.select().from(drafts)).toHaveLength(1);

    expect((await w.engine.mutate({ kind: "draft_discard", draftId: made.entityId! })).status)
      .toBe("confirmed");
    expect(await w.db.select().from(drafts), "Discard left the row on the account").toHaveLength(0);

    /* THE MIRROR NO LONGER HOLDS IT EITHER, and that is what the echoed tombstone buys. It was
       measured failing here first: `changes: []` sent the engine to a drain that BOOTSTRAPPED,
       a snapshot emits every live row as a create and cannot say "this one is gone", and the
       cursor it fixes skips the delete that was already in the log — so the discarded draft came
       back the moment the overlay was dropped. The second discard is therefore rejected LOCALLY,
       with nothing on the wire, which is also the right answer for a row another device removed. */
    const again = await w.engine.mutate({ kind: "draft_discard", draftId: made.entityId! });
    expect(again.status).toBe("rolled_back");
    expect(w.calls.filter((c) => c.startsWith("DELETE /drafts"))).toHaveLength(1);
  });

  it("a RICH reply delivers a multipart, and the client never asserts the plain part", async () => {
    /**
     * THE WHOLE CHAIN IN ONE ASSERTION — mutation, adapter, `DraftsService`, `SendService`,
     * `OutboundMessage` — against the real routes rather than a mocked wire.
     *
     * `html` is sent INSTEAD of `body`, never beside it. That is not a preference: the route
     * answers 400 to a request carrying both, because a client that supplied its own plain
     * part would be asserting what plaintext readers see, and the two halves of a
     * `multipart/alternative` would then be two clients' opinions rather than one rendering.
     * So this test is also the guard on that rule — send both and the mutation is rejected
     * here, in the client's own suite, instead of in somebody's outbox.
     *
     * `m.body` remains the LOCAL plain rendering (the overlay row, and the "is there anything
     * to send" check). What arrives at the transport is the server's, derived from the
     * sanitized markup, which is why the two assertions below differ in shape: the html is
     * echoed verbatim and the text is a rendering nobody in the browser chose.
     */
    const w = await world();

    const res = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: w.parent.id,
      body: "Yes — see the quote.",
      html: '<p>Yes — see <a href="https://a.example/q">the quote</a>.</p>',
    });
    expect(res.status).toBe("confirmed");

    expect(w.spy.delivered).toHaveLength(1);
    const msg = w.spy.delivered[0]!;
    expect(msg.html).toBe('<p>Yes — see <a href="https://a.example/q">the quote</a>.</p>');
    // The link's TARGET is in the plain part, and it is the SERVER's rendering — the client
    // sent "Yes — see the quote." and never this string.
    expect(msg.text).toBe("Yes — see the quote (https://a.example/q).");

    const rows = await w.db.select().from(drafts);
    expect(rows[0]!.html).toBe('<p>Yes — see <a href="https://a.example/q">the quote</a>.</p>');
    expect(rows[0]!.body).toBe("Yes — see the quote (https://a.example/q).");
  });

  it("a rich reply is SANITIZED before it is stored — the browser is not trusted", async () => {
    // The editor cannot produce this. A browser can, and `POST /drafts` accepts a string from
    // one, so the claim under test is that the server reduces it rather than that the client
    // behaves.
    const w = await world();
    await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: w.parent.id,
      body: "hi",
      html: '<p>hi</p><script>steal()</script><a href="javascript:alert(1)">x</a>',
    });
    const rows = await w.db.select().from(drafts);
    expect(rows[0]!.html).not.toContain("script");
    expect(rows[0]!.html).not.toContain("javascript");
    expect(w.spy.delivered[0]!.html).not.toContain("steal");
  });

  it("the IN-FLIGHT overlay is a `sending` draft, and no Sent copy exists before the server confirms", async () => {
    const w = await world();
    let overlayDraft: EngineDraft | undefined;
    let messagesInFlight = -1;
    w.setIntercept((_url, pass) => {
      // Read the mirror WHILE the mutation is in flight — this runs inside `dispatch`, BEFORE the
      // server has confirmed. The optimistic effect is one `sending` draft and NOTHING as mail:
      // materialising a Sent copy ahead of the confirmation would assert a delivery the server has
      // not owned (see `types.ts` `mail_send`). Threading only shows the Sent copy ON confirm, below.
      if (overlayDraft === undefined) {
        overlayDraft = w.engine.read().list<EngineDraft>("draft")[0];
        messagesInFlight = w.engine.read().list<EngineMessage>("message").length;
      }
      return pass();
    });

    await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "ok" });

    expect(overlayDraft?.status).toBe("sending");
    expect(overlayDraft?.to).toEqual([{ name: "Lena", address: "lena@atelier.example" }]);
    // Mid-flight: only the parent is in the mirror as mail — no fabricated Sent row yet.
    expect(messagesInFlight).toBe(1);
  });

  /**
   * A CONFIRMED SEND SHOWS ITS SENT COPY INSTANTLY, and reconciles away when the real one
   * lands. This REPLACES the old "never a Sent message row" assertion: the copy is materialised on
   * the server's `{status:"sent"}` confirmation (not optimistically), carries the minted
   * `messageIdHeader`, and the engine drops it the moment a drain delivers a real row under the same
   * header. The named new consumer of `providerMessageId` on `MutationOutcome`.
   *
   * Mutation that proves the guard bites: delete the `materializeSentOverlay(...)` call in
   * `OhmailEngine.dispatch` and the length-2 assertion fails — the conversation would carry only
   * the parent until the worker's Sent-folder watch caught up minutes later.
   */
  it("a CONFIRMED send materialises a local Sent copy in the parent's thread, unread:false, local:true", async () => {
    const w = await world();

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "ok" });
    expect(res.status).toBe("confirmed");

    const msgs = w.engine.read().list<EngineMessage>("message");
    // The parent PLUS the optimistic Sent copy — instantly, before any worker ingest.
    expect(msgs).toHaveLength(2);
    const sent = msgs.find((m) => m.local === true);
    expect(sent, "no optimistic Sent copy was materialised on confirm").toBeTruthy();
    expect(sent!.folder).toBe("Sent");
    expect(sent!.unread).toBe(false);
    expect(sent!.threadId).toBe(w.parent.threadId);
    // Its header is the minted id the server delivered — the reconcile key. `spy.delivered[0]`
    // carries the same `messageId`, which is what the real Sent row will arrive under.
    expect(sent!.messageIdHeader).toBe(w.spy.delivered[0]!.messageId);
    expect(sent!.messageIdHeader).toMatch(/^<.+@.+>$/);
  });

  /**
   * A FORWARD IS A MEMBER OF THE CONVERSATION IT WAS FORWARDED FROM — on the wire and in the
   * mirror. The server mints In-Reply-To/References off the original (measured here through the
   * real routes), and `enrich` files the confirm-time Sent copy under the original's thread, so
   * `threadOf(original)` holds both from the first frame. A COMPOSE stays threadless: the same
   * `inReplyTo: null` arm, no `forwardOf`, and nothing to inherit. Mutation watched red: pin
   * `threadId: null` again in `enrich`'s compose arm — the copy leaves the conversation.
   */
  it("a CONFIRMED forward files its Sent copy in the ORIGINAL's conversation and threads on the wire", async () => {
    const w = await world();
    // A REAL thread row: the forward's draft now names the original's thread on the wire, and the
    // server refuses a thread the account does not hold (404) — as it should.
    const threadId = await seedThread(w.db, { accountId: w.accountId, subject: "Werkstatt-Besuch?" });
    await w.db.update(messages).set({ threadId }); // the one row this world holds
    const original = { ...w.parent, threadId };
    await w.engine.store.applyChanges([
      { type: "message", op: "update", id: original.id, seq: 2, updatedAt: original.updatedAt, entity: original },
    ]);

    const res = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: original.id,
      subject: "Fwd: Werkstatt-Besuch?", body: "fyi",
      to: [{ name: "Sam", address: "sam@colleague.test" }],
    });
    expect(res.status).toBe("confirmed");

    const sent = w.engine.read().list<EngineMessage>("message").find((m) => m.local === true);
    expect(sent, "no optimistic Sent copy was materialised on confirm").toBeTruthy();
    expect(sent!.threadId).toBe(threadId);
    expect(threadOf(w.engine.read(), original.id).map((m) => m.id)).toEqual([original.id, sent!.id]);
    expect(isForwardedByUs(sent!)).toBe(true);

    // The wire: the original's Message-ID is the parent, and the chain is that id alone (the
    // seeded original has no thread root).
    expect(w.spy.delivered).toHaveLength(1);
    expect(w.spy.delivered[0]!.inReplyTo).toBe("<parent@atelier.example>");
    expect(w.spy.delivered[0]!.references).toBe("<parent@atelier.example>");
  });

  it("a no_forward original leaves ONLY with `forwardConfirmed` — adapter, route and service carry the ask's answer", async () => {
    // Forward is always offered (owner, 2026-09-25); the client asks once and the send states
    // the answer. Measured through the real routes: unconfirmed delivers nothing, confirmed goes.
    const w = await world();
    const threadId = await seedThread(w.db, { accountId: w.accountId, subject: "Werkstatt-Besuch?" });
    await w.db.update(messages).set({ threadId, noForward: true });
    const original = { ...w.parent, threadId };
    await w.engine.store.applyChanges([
      { type: "message", op: "update", id: original.id, seq: 2, updatedAt: original.updatedAt, entity: original },
    ]);
    const to = [{ name: "Sam", address: "sam@colleague.test" }];
    const refused = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: original.id, subject: "Fwd: Werkstatt-Besuch?", body: "fyi", to,
    });
    expect(refused.status).not.toBe("confirmed");
    expect(w.spy.delivered).toHaveLength(0);
    const res = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: original.id, forwardConfirmed: true,
      subject: "Fwd: Werkstatt-Besuch?", body: "fyi, as asked", to,
    });
    expect(res.status).toBe("confirmed");
    expect(w.spy.delivered).toHaveLength(1);
  });

  it("forwardParts rides the send only beside forwardOf; absent, the request is the one it always was", async () => {
    const w = await world();
    const to = [{ name: "Sam", address: "sam@colleague.test" }];
    const kept = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: w.parent.id, forwardParts: [],
      subject: "Fwd: Werkstatt-Besuch?", body: "fyi", to,
    });
    expect(kept.status).toBe("confirmed");
    expect(JSON.parse(w.sendBodies[0]!)).toMatchObject({ forwardOf: w.parent.id, forwardParts: [] });
    expect(w.spy.delivered[0]!.attachments ?? []).toEqual([]);
    const all = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: w.parent.id, subject: "Fwd: Werkstatt-Besuch?", body: "fyi too", to,
    });
    expect(all.status).toBe("confirmed");
    expect(JSON.parse(w.sendBodies[1]!)).not.toHaveProperty("forwardParts");
    // A reply carrying the field by mistake sends no field: there is no original to choose from.
    expect((await w.engine.mutate({
      kind: "mail_send", inReplyTo: w.parent.id, forwardParts: ["aaaaaaaa-0000-4000-8000-000000000001"], body: "ok",
    })).status).toBe("confirmed");
    expect(w.sendBodies[2] ?? "").not.toContain("forwardParts");
  });

  it("a forward's quoted date is the sender's clock — adapter and route carry the zone and language", async () => {
    const w = await world();
    const threadId = await seedThread(w.db, { accountId: w.accountId, subject: "Werkstatt-Besuch?" });
    await w.db.update(messages).set({ threadId, date: new Date("2026-09-26T06:00:06.000Z") });
    const original = { ...w.parent, threadId };
    await w.engine.store.applyChanges([
      { type: "message", op: "update", id: original.id, seq: 2, updatedAt: original.updatedAt, entity: original },
    ]);
    const res = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: original.id,
      forwardClock: { zone: "Europe/Zurich", locale: "de" },
      subject: "Fwd: Werkstatt-Besuch?", body: "fyi", to: [{ name: "Sam", address: "sam@colleague.test" }],
    });
    expect(res.status).toBe("confirmed");
    const line = /^Date: (.*)$/m.exec(w.spy.delivered[0]!.text ?? "")?.[1] ?? "";
    // 06:00 UTC is 08:00 in Zurich; the weekday is German.
    expect(line).toContain("08:00");
    expect(line).toMatch(/^Sa/);
  });

  it("a malformed clock never refuses the forward — the date reads in UTC, in English", async () => {
    const w = await world();
    const threadId = await seedThread(w.db, { accountId: w.accountId, subject: "Werkstatt-Besuch?" });
    await w.db.update(messages).set({ threadId, date: new Date("2026-09-26T06:00:06.000Z") });
    const original = { ...w.parent, threadId };
    await w.engine.store.applyChanges([
      { type: "message", op: "update", id: original.id, seq: 2, updatedAt: original.updatedAt, entity: original },
    ]);
    const res = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: original.id,
      forwardClock: { zone: "Europe/Zurich'; --", locale: "x".repeat(80) },
      subject: "Fwd: Werkstatt-Besuch?", body: "fyi", to: [{ name: "Sam", address: "sam@colleague.test" }],
    });
    expect(res.status).toBe("confirmed");
    const line = /^Date: (.*)$/m.exec(w.spy.delivered[0]!.text ?? "")?.[1] ?? "";
    expect(line).toContain("06:00");
    expect(line).toContain("UTC");
  });

  it("a COMPOSE with the same subject stays out of every conversation", async () => {
    const w = await world();
    // A REAL thread row: the forward's draft now names the original's thread on the wire, and the
    // server refuses a thread the account does not hold (404) — as it should.
    const threadId = await seedThread(w.db, { accountId: w.accountId, subject: "Werkstatt-Besuch?" });
    await w.db.update(messages).set({ threadId }); // the one row this world holds
    const original = { ...w.parent, threadId };
    await w.engine.store.applyChanges([
      { type: "message", op: "update", id: original.id, seq: 2, updatedAt: original.updatedAt, entity: original },
    ]);
    const res = await w.engine.mutate({
      kind: "mail_send", inReplyTo: null, subject: "Werkstatt-Besuch?", body: "new",
      to: [{ name: "Sam", address: "sam@colleague.test" }],
    });
    expect(res.status).toBe("confirmed");
    const sent = w.engine.read().list<EngineMessage>("message").find((m) => m.local === true);
    expect(sent!.threadId).toBeNull();
    expect(threadOf(w.engine.read(), original.id)).toEqual([]);
    expect(w.spy.delivered[0]!.inReplyTo).toBeUndefined();
  });

  /**
   * RECONCILE — the optimistic copy is DROPPED once the real Sent row arrives under the same
   * `messageIdHeader`, so the conversation never carries a duplicate. Driven directly through the
   * store + a drain, because in this in-process world there is no worker to ingest Sent.
   *
   * Mutation that proves it bites: make `reconcileOptimisticSent` compare against `id` instead of
   * `messageIdHeader` and the copy is never retired — the length stays 3 (parent + copy + real).
   */
  it("the optimistic Sent copy is reconciled away when the real Sent row is drained in", async () => {
    const w = await world();

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "ok" });
    expect(res.status).toBe("confirmed");
    const header = w.spy.delivered[0]!.messageId!;
    expect(w.engine.read().list<EngineMessage>("message").filter((m) => m.local === true)).toHaveLength(1);

    // The worker's Sent-folder watch, simulated: a real row arrives carrying the SAME id — in the
    // SHAPE THE SERVER ACTUALLY SENDS. Ingest strips the RFC 5322 angle brackets
    // (`identity.ts#normalizeMessageId`), so `messages.message_id_header` — and therefore the
    // DTO — carries `id@domain` while the send confirmation carries `<id@domain>`. This fixture
    // used to plant the BRACKETED spelling, which no ingested row has ever carried: the reconcile
    // passed against a row the server cannot produce, and on the real wire every optimistic copy
    // outlived its real row by the full ten-minute TTL, doubling the just-sent message in its
    // conversation and in Earlier. The folder is Exchange's, because a folder name outside the
    // organised six must change nothing here.
    const real: EngineMessage = {
      ...w.parent,
      id: "real-sent-row",
      messageIdHeader: header.replace(/[<>]/g, ""),
      folder: "Sent Items" as EngineMessage["folder"],
      unread: false,
      from: { name: "me", address: "me@atelier.example" },
    };
    await w.engine.store.applyChanges([
      { type: "message", op: "create", id: real.id, seq: 999, updatedAt: real.updatedAt, entity: real },
    ]);
    await w.engine.syncOnce();

    const msgs = w.engine.read().list<EngineMessage>("message");
    // The local copy is gone; the real row stands alone (parent + real = 2, no `local` row).
    expect(msgs.filter((m) => m.local === true), "the optimistic Sent copy was not reconciled away")
      .toHaveLength(0);
    expect(msgs.some((m) => m.messageIdHeader === header.replace(/[<>]/g, ""))).toBe(true);
  });

  /**
   * The same reconcile for a server that stores the header WITH its brackets. No deployed API
   * does today, but the reconcile must not trade one spelling for the other — both sides are
   * normalised, so either spelling of the same id retires the copy.
   */
  it("the optimistic Sent copy also reconciles against a bracketed header", async () => {
    const w = await world();
    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "ok" });
    expect(res.status).toBe("confirmed");
    const header = w.spy.delivered[0]!.messageId!;
    expect(header).toMatch(/^<.+>$/);

    const real: EngineMessage = {
      ...w.parent,
      id: "real-sent-row-bracketed",
      messageIdHeader: header,
      folder: "Sent Items" as EngineMessage["folder"],
      unread: false,
      from: { name: "me", address: "me@atelier.example" },
    };
    await w.engine.store.applyChanges([
      { type: "message", op: "create", id: real.id, seq: 999, updatedAt: real.updatedAt, entity: real },
    ]);
    await w.engine.syncOnce();

    expect(w.engine.read().list<EngineMessage>("message").filter((m) => m.local === true))
      .toHaveLength(0);
  });

  /**
   * A SELF-SEND — mail to your own address — RENDERS ONCE, not as twin panels.
   *
   * The self-send is the reconcile's least Sent-shaped case, and the one a UX pass caught as
   * twins on a live account. Its real row is often the RECEIVED copy: the INBOX watch runs
   * ahead of the Sent watch, and ingest collapses the Sent observation of a message already
   * held into `own_copy` (`dedup.ts` names CC-ing yourself as the founding case) — so the ONE
   * mirror row for a self-send can arrive in INBOX, an organised folder, from the account
   * itself. The reconcile must retire the optimistic copy against exactly that row: it scans
   * the whole mirror by `messageIdKey` with no folder or sender test, and this pin is what
   * keeps a future "only Sent-shaped rows retire" optimisation from resurrecting the twins.
   *
   * Mutation that proves it bites while the Sent-shaped pins above stay green: skip rows whose
   * folder is one of the organised views in `reconcileOptimisticSent` — this fails, the
   * "Sent Items" tests pass.
   */
  it("a SELF-SEND's received copy (INBOX, from yourself) retires the optimistic copy — one row, not twins", async () => {
    const w = await world();

    // A compose addressed to the account's own address — the self-send.
    const res = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: null,
      mailboxId: w.parent.mailboxId,
      subject: "note to self",
      body: "the receipt is attached",
      to: [{ name: null, address: "me@atelier.example" }],
    });
    expect(res.status).toBe("confirmed");
    const header = w.spy.delivered[0]!.messageId!;
    expect(w.engine.read().list<EngineMessage>("message").filter((m) => m.local === true)).toHaveLength(1);

    // The received copy, as ingest would deliver it: INBOX, self as sender AND recipient,
    // bracket-stripped header — the one row a self-send keeps after dedup.
    const real: EngineMessage = {
      ...w.parent,
      id: "real-selfsend-row",
      messageIdHeader: header.replace(/[<>]/g, ""),
      folder: "INBOX",
      subject: "note to self",
      unread: true,
      from: { name: "me", address: "me@atelier.example" },
      to: [{ name: null, address: "me@atelier.example" }],
    };
    await w.engine.store.applyChanges([
      { type: "message", op: "create", id: real.id, seq: 999, updatedAt: real.updatedAt, entity: real },
    ]);
    await w.engine.syncOnce();

    const msgs = w.engine.read().list<EngineMessage>("message");
    expect(msgs.filter((m) => m.local === true), "the self-send's optimistic copy was not retired")
      .toHaveLength(0);
    // Exactly ONE row carries the minted id — the panel count of the twin report.
    expect(msgs.filter((m) => m.messageIdHeader?.replace(/[<>]/g, "") === header.replace(/[<>]/g, "")))
      .toHaveLength(1);
  });

  /**
   * DROP ON REJECTION — a send that the server does NOT confirm leaves no Sent copy behind. This is
   * the "materialise ONLY on confirm" rule from the other side: the rejection path never reaches
   * `materializeSentOverlay`.
   *
   * Mutation that proves it bites: move the `materializeSentOverlay` call above the `try` (or into
   * the `catch`) and this goes red — a message the recipient never got would appear as sent.
   */
  it("a rejected send (unverified) leaves NO Sent copy in the mirror", async () => {
    const w = await world();
    w.spy.throwOnSend = true;
    w.spy.foundInSent = false;

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "ok" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("send_unverified");

    // Only the parent — nothing local was fabricated for a send that did not confirm.
    const msgs = w.engine.read().list<EngineMessage>("message");
    expect(msgs).toHaveLength(1);
    expect(msgs.some((m) => m.local === true)).toBe(false);
  });

  /**
   * AN ATTACHMENT IS DELIVERED AND LEAVES ZERO BYTES AT REST.
   *
   * The bytes ride the send request (base64), the server decodes them onto the `OutboundMessage`,
   * and `outboundToMail` puts them on the ONE message that both goes out and is appended to Sent.
   * Nothing writes them anywhere: the `attachments` table stays empty (it holds INGEST metadata, and
   * we never ingest our own outbound in-process) and no `drafts` column carries the marker bytes.
   *
   * Mutation that proves zero-at-rest bites: have the send route persist `attachments` (e.g. write a
   * row) and the `attachments`-empty assertion goes red. Mutation that proves delivery bites: drop
   * the passthrough in `outboundToMail` and the `spy.delivered[0].attachments` assertion goes red.
   */
  it("a send WITH an attachment delivers the bytes and persists none of them", async () => {
    const w = await world();
    const marker = `ZERO_AT_REST_${Math.random().toString(36).slice(2)}`;
    const contentBase64 = Buffer.from(marker).toString("base64");

    const res = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: w.parent.id,
      body: "see attached",
      attachments: [{ filename: "note.txt", contentType: "text/plain", contentBase64 }],
    });
    expect(res.status).toBe("confirmed");

    // Delivered: the transport got the file, bytes intact.
    expect(w.spy.delivered).toHaveLength(1);
    const att = w.spy.delivered[0]!.attachments;
    expect(att, "the attachment never reached the transport").toBeTruthy();
    expect(att).toHaveLength(1);
    expect(att![0]!.filename).toBe("note.txt");
    expect(Buffer.from(att![0]!.content).toString()).toBe(marker);

    // ZERO AT REST: no attachment row, and the marker bytes are in no drafts column.
    expect(await w.db.select().from(attachments), "an attachment row was persisted").toHaveLength(0);
    const rows = await w.db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]), "the attachment bytes were stored on the draft")
      .not.toContain(marker);
    expect(JSON.stringify(rows[0])).not.toContain(contentBase64);
  });

  it("attachments over the total cap are refused, and nothing is delivered", async () => {
    const w = await world();
    // ~4 MB of raw bytes — over `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (3 MB).
    const big = Buffer.alloc(4 * 1024 * 1024, 0x41).toString("base64");

    const res = await w.engine.mutate({
      kind: "mail_send",
      inReplyTo: w.parent.id,
      body: "too big",
      attachments: [{ filename: "big.bin", contentType: "application/octet-stream", contentBase64: big }],
    });

    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("payload_too_large");
    expect(w.spy.delivered).toHaveLength(0);
    // The draft was created (attachments are not part of it) but no send row was finalized sent.
    const sends = await w.db.select().from(outboundSends);
    expect(sends.filter((s) => s.status === "sent")).toHaveLength(0);
  });

  it("CRUX — a retry after the send request is lost does NOT deliver twice", async () => {
    const w = await world();
    let failNextSend = true;
    w.setIntercept((url, pass) => {
      if (!url.includes("/send") || !failNextSend) return pass();
      failNextSend = false;
      return Promise.reject(new Error("connection reset"));
    });

    const first = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });
    // Retryable ⇒ the intent stands, queued under the SAME key, overlay kept.
    expect(first.status).toBe("queued");
    expect(w.engine.pendingMutations()).toHaveLength(1);
    expect(w.engine.read().list<EngineDraft>("draft")[0]!.status).toBe("sending");

    const flushed = await w.engine.flushPending();
    expect(flushed[0]!.status).toBe("confirmed");
    expect(flushed[0]!.key).toBe(first.key);

    // ONE delivery. And ONE draft: the memoized draftId meant the retry re-sent the draft
    // the first attempt created rather than composing a second one.
    expect(w.spy.delivered).toHaveLength(1);
    expect(await w.db.select().from(drafts)).toHaveLength(1);
    expect(w.calls.filter((c) => c === "POST /drafts")).toHaveLength(1);
  });

  it("a LOST CREATE RESPONSE no longer costs an orphan draft — one row, one delivery", async () => {
    // This test used to be titled "…costs an orphan draft", and the orphan was the accepted
    // price: the in-memory memo has no id to remember when the ANSWER is lost, so the retry
    // re-created the row and the first one sat unseen forever. POST /drafts is now
    // idempotent-marked (the durable-outbox slice: a restart can replay a create hours later),
    // the service claims the key in the same transaction that writes the row, and the retry
    // therefore replays the stored 201 — the SAME row, no orphan. The half that was always the
    // point is unchanged and still pinned: exactly one delivery.
    const w = await world();
    let dropNextCreate = true;
    w.setIntercept(async (url, pass) => {
      if (!url.endsWith("/drafts") || !dropNextCreate) return pass();
      dropNextCreate = false;
      // Let the server COMMIT the draft, then lose the answer.
      await pass();
      throw new Error("socket hang up");
    });

    const first = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });
    expect(first.status).toBe("queued");   // a transport failure is retryable
    expect(w.spy.delivered).toHaveLength(0);

    const flushed = await w.engine.flushPending();
    expect(flushed[0]!.status).toBe("confirmed");
    expect(flushed[0]!.key).toBe(first.key);

    // ONE draft row — the idempotent replay reused the committed one — and it was sent.
    const rows = await w.db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(w.spy.delivered).toHaveLength(1);
  });

  it("SMTP threw and Sent has no copy ⇒ `send_unverified`, rolled back, NOT retryable", async () => {
    const w = await world();
    w.spy.throwOnSend = true;
    w.spy.foundInSent = false;

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });

    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("send_unverified");
    expect(res.error?.retryable).toBe(false);
    expect(res.error?.message).toMatch(/Sent folder/i);
    // The server really probed Sent and really moved to the ambiguous terminal state.
    expect(w.spy.probes).toHaveLength(1);
    const rows = await w.db.select().from(drafts);
    expect(rows[0]!.status).toBe("unverified");
    // Nothing was delivered by us, and nothing is left queued to deliver later.
    expect(w.spy.delivered).toHaveLength(0);
    expect(w.engine.pendingMutations()).toHaveLength(0);
  });

  it("SMTP threw but the copy IS in Sent ⇒ reconciled to sent, no resend", async () => {
    const w = await world();
    w.spy.throwOnSend = true;
    w.spy.foundInSent = true;

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });

    expect(res.status).toBe("confirmed");
    expect(w.spy.delivered).toHaveLength(0); // the probe reconciled it; `send` ran once and threw
    const rows = await w.db.select().from(drafts);
    expect(rows[0]!.status).toBe("sent");
  });

  it("an unknown parent is rejected locally, with no request on the wire", async () => {
    const w = await world();

    const res = await w.engine.mutate({ kind: "mail_send", inReplyTo: "no-such-message", body: "hello" });

    expect(res.status).toBe("rolled_back");
    expect(res.error?.status).toBe(404);
    expect(w.calls).toHaveLength(0);
  });

  it("`Re:` is added once, case-insensitively", () => {
    expect(replySubject("Werkstatt-Besuch?")).toBe("Re: Werkstatt-Besuch?");
    expect(replySubject("Re: Werkstatt-Besuch?")).toBe("Re: Werkstatt-Besuch?");
    expect(replySubject("RE: re: Werkstatt-Besuch?")).toBe("Re: Werkstatt-Besuch?");
    expect(replySubject("")).toBe("Re:");
    // Only the LEADING prefix; a subject that merely contains "re:" is left alone.
    expect(replySubject("Ticket re: the roof")).toBe("Re: Ticket re: the roof");
  });
});

/**
 * The two outcomes the SERVICE cannot currently produce — `failed` is declared by
 * `SendService` and never written by it, and `in_flight` needs a live concurrent invocation.
 * The route's answers for both are fixed (`packages/api/src/routes/drafts.ts:82-91`) and
 * covered there; what is under test HERE is that this adapter reads them correctly, because
 * both arrive as `{status, message}` and NOT as the `{error:{…}}` envelope every other
 * mutation returns. A `rejectionOf()` shortcut would report `HTTP 409` with a null code and
 * lose the difference between "definitely not delivered" and "still going".
 */
describe("mail_send — the wire shapes `rejectionOf` cannot read", () => {
  function stubbed(sendResponse: Response): { adapter: HttpAdapter; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith("/drafts")) {
        return new Response(JSON.stringify({ id: "draft-1" }), {
          status: 201, headers: { "content-type": "application/json", "x-sync-seq": "7" },
        });
      }
      return sendResponse;
    };
    return { adapter: new HttpAdapter({ baseUrl: "", fetch: fetchImpl }), calls };
  }

  const mutation = {
    kind: "mail_send" as const,
    inReplyTo: "m1",
    body: "hi",
    mailboxId: "mb1",
    subject: "Re: x",
    to: [{ name: null, address: "a@example.com" }],
  };

  it("409 {status:'failed'} ⇒ send_failed, NOT retryable", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ status: "failed", message: "A prior send under this key failed and was not delivered." }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));

    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).code).toBe("send_failed");
    expect((err as MutationRejectedError).retryable).toBe(false);
    expect((err as MutationRejectedError).message).toMatch(/was not delivered/);
  });

  it("409 {status:'in_flight'} ⇒ RETRYABLE, so the intent stays queued", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ status: "in_flight", message: "A send for this draft is already in progress." }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));

    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);

    expect((err as MutationRejectedError).code).toBe("send_in_flight");
    expect((err as MutationRejectedError).retryable).toBe(true);
  });

  it("an in_flight retry re-sends the SAME draft — the create is not repeated", async () => {
    const { adapter, calls } = stubbed(new Response(
      JSON.stringify({ status: "in_flight" }), { status: 409, headers: { "content-type": "application/json" } },
    ));

    await adapter.mutate(mutation, { idempotencyKey: "k" }).catch(() => { /* expected */ });
    await adapter.mutate(mutation, { idempotencyKey: "k" }).catch(() => { /* expected */ });

    expect(calls.filter((c) => c.endsWith("/drafts"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("/drafts/draft-1/send"))).toHaveLength(2);
  });

  it("a rejection from IN FRONT of SendService keeps the server's own sentence", async () => {
    // The gate, auth, CSRF and 5xx all answer the ordinary `{error:{…}}` envelope with no
    // `status` field — `SendService` never ran. Flattening those to "HTTP 403" would put a
    // status code on screen where the server had written a sentence, and the `failed` state
    // is nothing but that sentence.
    const { adapter } = stubbed(new Response(
      JSON.stringify({ error: { code: "email_unverified", message: "Verify your email before sending mail." } }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));

    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);

    expect((err as MutationRejectedError).code).toBe("email_unverified");
    expect((err as MutationRejectedError).message).toBe("Verify your email before sending mail.");
    expect((err as MutationRejectedError).retryable).toBe(false);
  });

  /**
   * THE AMBIGUITY GUARD, IN BOTH DIRECTIONS — and it had no test in either.
   *
   * The guard exists for a real case: an UNREADABLE answer at a status that says the server acted
   * (a truncated body, a proxy rewrite, a 200 that never finished writing) must be retried under
   * the SAME key rather than given up on, because giving up mints a fresh key and on a path with
   * no draft id that is a second `POST /drafts` and a second delivery.
   *
   * But it asked only whether the body carried one of the five send statuses, and a typed
   * `ServiceError` from the send path carries none — it rides the ordinary `{error:{code,message}}`
   * envelope. So every named 409 was rewritten into a retryable `send_in_flight`: the surface said
   * "a send is already in progress" about a request the server had refused outright, and the outbox
   * replayed a refusal that can only be refused again until it spent its give-up budget.
   *
   * Two cases, because the fix is a narrowing and a narrowing can go one step too far. Either one
   * alone would pass under a mistake in the other direction.
   */
  it("an UNREADABLE 409 is still retryable under the same key — the guard's own case", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ nonsense: true }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect((err as MutationRejectedError).code).toBe("send_in_flight");
    expect((err as MutationRejectedError).retryable, "an unread answer must be asked again").toBe(true);
  });

  it("a TYPED 409 keeps its own code and is terminal — mailbox_disabled reaches the surface", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ error: { code: "mailbox_disabled", message: "This mailbox is disconnected and cannot send.", retryable: false } }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect((err as MutationRejectedError).code).toBe("mailbox_disabled");
    expect((err as MutationRejectedError).retryable, "a refusal the server named is terminal").toBe(false);
    expect((err as MutationRejectedError).message).toContain("disconnected");
  });

  /**
   * `duplicate_send` — the server's own 409 for a second copy of a message it already has.
   *
   * It rides the ORDINARY error envelope, exactly like `mailbox_disabled` above, which is why this
   * adapter needs no branch for it — and why it needs the narrowing those two cases pin: without it
   * this refusal was rewritten into a retryable `send_in_flight` too. What it needs beyond that is
   * for the envelope's `details` to survive: the surface renders one of three sentences depending
   * on what became of the first send, and a code with no facts attached cannot tell them apart.
   * Dropping `details` here would leave the shell with a phase and no way to say anything true
   * about it — and every other assertion on this path would stay green.
   */
  it("a duplicate refusal is classified from the envelope, DETAILS included", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({
        error: {
          code: "duplicate_send",
          message: "This exact message was already sent from this mailbox at 2026-07-28T12:00:00.000Z.",
          retryable: false,
          details: { firstSend: { status: "unverified", at: "2026-07-28T12:00:00.000Z" } },
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));

    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).code).toBe("duplicate_send");
    // NOT retryable: the outbox must settle it rather than replay it for ever.
    expect((err as MutationRejectedError).retryable).toBe(false);
    expect((err as MutationRejectedError).details)
      .toEqual({ firstSend: { status: "unverified", at: "2026-07-28T12:00:00.000Z" } });
  });

  it("a refusal that carries NO details leaves `details` undefined rather than inventing one", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ error: { code: "mailbox_disabled", message: "This mailbox is disconnected." } }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect((err as MutationRejectedError).code).toBe("mailbox_disabled");
    expect((err as MutationRejectedError).details).toBeUndefined();
  });

  it("X-Sync-Seq is recorded even when the send is rejected", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ status: "unverified", message: "We couldn't confirm this send." }),
      { status: 200, headers: { "content-type": "application/json", "x-sync-seq": "42" } },
    ));

    await adapter.mutate(mutation, { idempotencyKey: "k" }).catch(() => { /* expected */ });

    expect(adapter.lastSyncSeq).toBe(42);
  });

  it("a 200 is INSPECTED, not trusted: {status:'unverified'} never reads as success", async () => {
    const { adapter } = stubbed(new Response(
      JSON.stringify({ status: "unverified", message: "We couldn't confirm this send." }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const err = await adapter.mutate(mutation, { idempotencyKey: "k" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).code).toBe("send_unverified");
  });

  /**
   * VERSION SKEW: a bcc that the server silently dropped must NEVER become a send.
   *
   * The `stubbed` create above echoes `{ id }` and no `bcc` array — exactly the shape an API that
   * predates the field returns, because it reads named fields and ignores the rest rather than
   * 400ing an unknown key. If the adapter went on to `/send`, the mail would leave addressed to
   * To/Cc only and the sender would believe people were blind-copied who were not — a silent
   * correctness failure. The guard catches it before the irreversible second request.
   */
  it("refuses to send when bcc was requested but the created draft did not echo it", async () => {
    const { adapter, calls } = stubbed(new Response(
      JSON.stringify({ status: "sent", providerMessageId: "<x@y>" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const withBcc = { ...mutation, bcc: [{ name: null, address: "blind@example.com" }] };
    const err = await adapter.mutate(withBcc, { idempotencyKey: "kb" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).code).toBe("bcc_unsupported");
    expect((err as MutationRejectedError).retryable).toBe(false);
    // The draft was created, but the send request was NEVER made.
    expect(calls.some((c) => c.endsWith("/drafts"))).toBe(true);
    expect(calls.some((c) => c.includes("/send"))).toBe(false);
  });

  /**
   * IDENTITY SKEW: a From pick the server did not confirm must NEVER become a send.
   *
   * The reuse path (an autosaved row) PUTs the mutation's `mailboxId` — the identity the From
   * line rendered at press time — before the send. A server that predates the movable column
   * reads named fields and ignores the rest, so the PUT "succeeds" and echoes the ROW's old
   * mailbox; going on to `/send` would deliver under an identity the sender explicitly moved
   * off. That is the wrong-From incident this whole seam exists to close, so the echo is
   * checked and the send refused — same shape as the bcc guard one test up. A blipped PUT
   * (no echo at all) refuses too: for TEXT a stale row is at most two seconds old, but the
   * row's IDENTITY may be days old, so "probably fine" is not available here.
   */
  it("refuses to send when the PUT did not confirm the picked sending mailbox", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PUT") {
        // An old server: the field was ignored, the echo carries the row's frozen mailbox.
        return new Response(
          JSON.stringify({ id: "draft-1", mailboxId: "mb-frozen" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ status: "sent", providerMessageId: "<x@y>" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = new HttpAdapter({ baseUrl: "", fetch: fetchImpl });

    const err = await adapter.mutate(
      {
        kind: "mail_send", inReplyTo: null, draftId: "draft-1", mailboxId: "mb-picked",
        subject: "x", body: "hi", to: [{ name: null, address: "a@example.com" }],
      },
      { idempotencyKey: "km" },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).code).toBe("from_mailbox_unconfirmed");
    expect((err as MutationRejectedError).retryable).toBe(false);
    expect(calls.some((c) => c.includes("/send")), "the send went out under an unconfirmed identity").toBe(false);
  });

  it("a picked mailbox the server DID echo proceeds to send", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({ id: "draft-1", mailboxId: "mb-picked" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ status: "sent", providerMessageId: "<x@y>" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = new HttpAdapter({ baseUrl: "", fetch: fetchImpl });

    const res = await adapter.mutate(
      {
        kind: "mail_send", inReplyTo: null, draftId: "draft-1", mailboxId: "mb-picked",
        subject: "x", body: "hi", to: [{ name: null, address: "a@example.com" }],
      },
      { idempotencyKey: "km2" },
    );

    expect(res).toBeTruthy();
    expect(calls.some((c) => c.includes("/drafts/draft-1/send"))).toBe(true);
  });

  it("a bcc that the server DID echo proceeds to send normally", async () => {
    // The complement: a server that understands bcc returns the array (here non-empty), so the
    // guard is silent and the send goes through. A plain send without bcc is unaffected by all of
    // this — every other test in this block sends `mutation`, which carries no bcc.
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith("/drafts")) {
        return new Response(
          JSON.stringify({ id: "draft-1", bcc: [{ name: null, address: "blind@example.com" }] }),
          { status: 201, headers: { "content-type": "application/json", "x-sync-seq": "7" } },
        );
      }
      return new Response(
        JSON.stringify({ status: "sent", providerMessageId: "<x@y>" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = new HttpAdapter({ baseUrl: "", fetch: fetchImpl });
    const withBcc = { ...mutation, bcc: [{ name: null, address: "blind@example.com" }] };

    const res = await adapter.mutate(withBcc, { idempotencyKey: "kb2" });

    expect(res).toBeTruthy();
    expect(calls.some((c) => c.endsWith("/drafts/draft-1/send"))).toBe(true);
  });
});
