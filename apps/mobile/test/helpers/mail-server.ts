/**
 * A loopback mail server speaking /sync + the mutation contract — the test-side synthetic
 * dataset the mobile suites drive the REAL engine against. Extracted from the live-screens
 * suite so the no-collapse census runs over the same wire; nothing here ships in the app.
 */
import { createServer, type Server } from "node:http";
import { encodeSeqCursor, twinWinner, type EmailAddress, type RuleDTO, type SyncChange } from "@ohmail/client-engine";

export type Dto = ReturnType<typeof dto>;

export function dto(id: string, opts: {
  subject?: string;
  folder?: string;
  from?: { name: string; address: string };
  unread?: boolean;
  date?: string;
  /** The `message_states` row the wire carries — `null` (the default) for a message with none. */
  triage?: { state: string } | null;
} = {}) {
  return {
    id,
    accountId: "acct-1",
    mailboxId: "mb-1",
    threadId: null as string | null,
    messageIdHeader: `<${id}@fake>`,
    subject: opts.subject ?? id,
    from: opts.from ?? { name: "Test Sender", address: "sender@fake.test" },
    // Typed, not bare: `[]` infers `never[]`, which refuses the scenes that put a recipient on
    // a row (`{ ...dto("a2"), to: [addr] }` — the address-search suite's shape). The type is
    // the WIRE's, so a nameless recipient — what every existing scene writes — still compiles.
    to: [] as EmailAddress[],
    cc: [] as EmailAddress[],
    date: opts.date ?? "2026-08-19T08:00:00Z",
    folder: opts.folder ?? "INBOX",
    snippet: opts.subject ?? id,
    unread: opts.unread ?? true,
    lastReadAt: null as string | null,
    openReadAt: null as string | null,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: (opts.triage
      ? { messageId: id, state: opts.triage.state, bubbleUpAt: null, setAt: opts.date ?? "2026-08-19T08:00:00Z", updatedAt: opts.date ?? "2026-08-19T08:00:00Z" }
      : null) as unknown,
    labels: [] as string[],
    remoteContent: "none",
    updatedAt: "2026-08-19T08:00:00Z",
  };
}

export function ruleDto(id: string, kind: "sender" | "domain", match: string, destination: string): RuleDTO {
  return {
    id, kind, match, destination: destination as RuleDTO["destination"],
    priority: 0, provenance: "promoted", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-19T07:00:00Z", updatedAt: "2026-08-19T07:00:00Z",
  } as RuleDTO;
}

/**
 * The mail server: one change log (the SyncService shape), plus the mutation routes the
 * mobile screens dispatch through the engine — `PATCH /messages` (mark_seen), per-id PATCH
 * (feed_mark_seen), `/move`, `/triage`, `POST /screener/:id`, the rules CRUD the release
 * family rewrites, and the message-action routes the reading screen's verbs ride:
 * `POST /drafts` + `POST /drafts/:id/send` (reply / reply all / forward) and
 * `POST /messages/:id/tags` (tag_assign). `failNext(method, pathPrefix)` arms ONE 422
 * refusal, which is how the rollback halves are measured against a real wire rather than a
 * stubbed adapter.
 */
export function mailServer() {
  const log: SyncChange[] = [];
  let unscreenedBound: number | null = null;
  const messages = new Map<string, Dto>();
  /**
   * WHAT THE SERVER'S TRASH HOLDS — every DELETEd message, with when and where it came from.
   * `GET /messages?view=trash` pages it newest deletion first and `POST /messages/:id/restore`
   * takes one back out, so "Trash lists what the server holds and restore moves it back" is
   * measured against this map, never against what the client thinks it deleted.
   */
  const trash = new Map<string, { dto: Dto; trashedAt: string; restoreTo: string }>();
  /** The stored body per message id — what the two body routes below serve. */
  const bodies = new Map<string, string>();
  /** The stored html part per message id, where it has one. */
  const htmls = new Map<string, string>();
  /** The one-click posture each body's headers carry, as the server derives it; absent ⇒ `no_header`. */
  const postures = new Map<string, "one_click" | "no_header" | "mailto_only" | "not_one_click">();
  /** A body the server holds only as a husk, and why — the single route answers `withheld`. */
  const withheld = new Map<string, "storage_cap" | "junk_filed" | "expunged">();
  const rules = new Map<string, RuleDTO>();
  /** Why a row stayed, as the server's pass facts classify it (`GET /screener/stayed`). */
  const stayedWhy = new Map<string, string>();
  /**
   * Every request, with the `Idempotency-Key` the client put on it. The header is what separates
   * a retry from a second delivery: two sends under ONE key are one message on the real service
   * (`outbound_sends` is UNIQUE on `(accountId, idempotencyKey)`), two keys are two messages. A
   * count of `/send` requests alone cannot tell those apart, so the key is recorded beside it.
   */
  const seen: Array<{ method: string; url: string; body: string; key: string | null }> = [];
  const failures: Array<{ method: string; prefix: string; status?: number; body?: unknown }> = [];
  /** Each message's attachment list, as `GET /messages/:id/attachments` answers it. */
  const files = new Map<string, Array<{ id: string; filename: string; contentType: string; sizeBytes: number; inline: boolean }>>();
  /** What `GET /hello` announces under `features`; unset, the route is not served. */
  let helloFeatures: Record<string, unknown> | null = null;
  /** Routes armed to ACCEPT the request and never answer — the hung-server shape. */
  const hangs: Array<{ method: string; prefix: string }> = [];
  /**
   * Routes armed to be HANDLED at once and ANSWERED only when the test releases them — the slow
   * server, with the delay in the test's hand rather than on a clock. The request is on record in
   * {@link seen} the moment it lands, which is what an ordering assertion reads.
   */
  const holds: Array<{ method: string; prefix: string; arrive: (answer: () => void) => void }> = [];
  /**
   * Routes armed to answer 202 `{pending, requestId, holder, dto}` — a mailbox this install only
   * READS, where the server records the press for the organizer and does nothing else. The body
   * is what `MessageService.requestMove` sends, `dto` included and UNCHANGED: a double that
   * answers a queued state differently from production is how this defect stayed hidden.
   */
  const queuedForOrganizer: Array<{ method: string; prefix: string; holder: string | null }> = [];
  let seq = 0;

  const push = (type: string, op: "create" | "update" | "delete", id: string, entity: unknown) => {
    seq += 1;
    log.push({ type, op, id, seq, updatedAt: new Date().toISOString(), entity } as SyncChange);
  };
  /** How many senders one `GET /screener` page carries — the client's paging, driven. */
  let screenerPageSize = 200;
  /** Off by default: when on, a rule written with `applyRetro: true` answers its pass as requested. */
  let stampRetro = false;
  /** What `GET /organizer-requests` lists — this install's requests to the organizer. */
  let waitingRequests: unknown[] = [];
  /** What `GET /screener` names under `pendingDecisions` — this install's decisions still with the organizer. */
  let pendingDecisions: unknown[] = [];
  const addMessage = (m: Dto) => { messages.set(m.id, m); push("message", "create", m.id, m); };
  /** Mail the store holds and no drain carries — what a windowed mirror never received. */
  const holdOnServer = (m: Dto) => { messages.set(m.id, m); };
  const addRule = (r: RuleDTO) => { rules.set(r.id, r); push("rule", "create", r.id, r); };
  /** The folder inventory the stage-2 verb routes serve DTOs from. */
  interface FolderRow {
    id: string; name: string; mailboxId: string; mailbox: string; updatedAt: string;
    op?: { kind: "create" | "rename" | "delete"; to?: string; error?: string };
  }
  const folders = new Map<string, FolderRow>();
  /** A `folder` entity on /sync — served only while the account's folders flag is on. */
  const addFolder = (id: string, name: string, mailbox = "owner@fake.test", mailboxId = "mb-1") => {
    const row: FolderRow = { id, name, mailboxId, mailbox, updatedAt: new Date().toISOString() };
    folders.set(id, row);
    push("folder", "create", id, row);
  };
  /** The consent row's folders half — `GET /consent` serves it, `PATCH /consent/settings` moves it. */
  let foldersEnabledAt: string | null = null;
  /** The per-mailbox signatures map `GET /consent` serves beside the flag (mail 0075). */
  let signatures: Record<string, string> | undefined;
  /**
   * THE ACCOUNT'S CUTLINE ANSWER, the three fields `GET /consent` serves together (mail 0056 /
   * 0083). `undefined` for the whole bag stands for an API too old to carry them — the answer
   * then OMITS all three, which is what such a server really serves and what the phone's read
   * has to treat as "no answer" rather than as a window of its own.
   */
  let screening: { dormancyDays: number; screeningBaselineAt: string | null; screeningScope: string } | undefined =
    { dormancyDays: 21, screeningBaselineAt: null, screeningScope: "window" };
  /**
   * The account's appearance face (OHMARCHY-PLAN.md §3a). `undefined` stands for an API deployed
   * before the field existed — the answer then OMITS it, which is the shape such a server really
   * serves and the one the phone's read has to treat as "no preference".
   *
   * `null` is the account having no preference, and `'paper'` is the account having chosen paper.
   * The real service keeps those apart deliberately (`setThemeFace` stores `'paper'` rather than
   * collapsing it to NULL), so this fake keeps them apart too — a fake that collapsed them would
   * be satisfied by a client that could not tell them apart either.
   */
  let themeFace: string | null | undefined;
  /** The unsubscribe switch (mail 0054): `undefined` omits it — an API too old to carry it. */
  let blockAutoUnsubscribeAt: string | null | undefined;
  /* THE SENT-MAIL SEED: `undefined` omits `seedConfirmedAt` (a door without it); the review is what GET answers. */
  let seedConfirmedAt: string | null | undefined;
  let seedReview: unknown = { candidates: [], excluded: [], scannedMessages: 0, truncated: false };
  /**
   * The account ACCEPTS a face write and leaves the row as it was — a policy the client cannot
   * see, answered 200. The only thing separating "the account adopted ohmarchy" from "it did
   * not" is then whether the client reads the echo or the argument it sent.
   */
  let declineFace = false;
  /** The delete confirm's server-truth numbers; unset ⇒ the summary route answers 404. */
  let summaryCounts: { folders: number; messages: number } | null = null;
  const updateMessage = (id: string, patch: Partial<Dto>) => {
    const held = messages.get(id);
    if (!held) return;
    const next = { ...held, ...patch, updatedAt: new Date().toISOString() };
    messages.set(id, next);
    push("message", "update", id, next);
  };

  const drafts = new Map<string, Record<string, unknown>>();
  /**
   * WHAT WAS ACTUALLY DELIVERED, BY KEY — the real service's `outbound_sends` UNIQUE
   * `(accountId, idempotencyKey)`: a second send under a key it already holds is answered from
   * the first and dials nothing. A fake that delivered twice under one key would be satisfied by
   * a client that mints a fresh key per press, which is the defect this shape exists to measure.
   */
  const sentByKey = new Map<string, unknown>();
  /** Keys a Send again itself delivered under: their replay is this press's own send, no `firstSend`. */
  const againSentKeys = new Set<string>();
  /** The next N Send agains are taken and their answer lost: 202 queued after they went. */
  let againAnswersLost = 0;
  /** Draft ids the scheduled-send pass has CLAIMED — a cancel on one answers 409. */
  const claimed = new Set<string>();
  let draftSeq = 0;
  let unverifiedSends = 0;
  /** The row each `POST /drafts` key made — the route replays it (`options: { idempotent: true }`). */
  const createdByKey = new Map<string, string>();
  /** The request body each `POST /drafts` key was first stored with — the middleware's request hash. */
  const createHash = new Map<string, string>();
  /**
   * THE PHONE'S ENGINE WITH THE NETWORK CUT, as `phone-offline-send.test.ts` measured it: a send
   * key's first attempt answers 500 (the dial error the pre-SMTP window rethrows), and the key is
   * spent `failed` from then on (409). The row stays an ordinary draft.
   */
  let sendsOffline = false;
  /** An older server without the sent-row belt: a PUT rewrites a sent row and answers 200 (`unbeltedSentRows`). */
  let unbelted = false;
  const failedSendKeys = new Set<string>();
  /**
   * KEYS A CANCEL TOMBSTONED — `POST /sends/withdraw` on a key this server never reserved, as
   * `SendService.withdraw` writes it: the key's send answers 409 `send_withdrawn` and delivers nothing.
   */
  const withdrawnKeys = new Set<string>();
  /** `false`: the withdraw route answers 404, a server that predates it. */
  let withdrawRoute = true;
  /** `true`: a created row carries `status: "draft"` and its stamps, as `DraftsService.create` writes it. */
  let stampedDrafts = false;
  /**
   * THE SERVER'S CONTENT CLAIM (`SEND_DUPLICATE_WINDOW_MS`): within the hour, the same message
   * from the same mailbox under a NEW key is refused 409 `duplicate_send`, naming the first send.
   * Off unless asked (`setContentClaim`); a send carrying staged files has no claim on the server.
   */
  let contentClaim = false;
  const deliveredContent = new Map<string, number>();
  const duplicateKeys: string[] = [];
  const contentOf = (row: Record<string, unknown>): string => JSON.stringify([
    row.mailboxId ?? null, row.to ?? [], row.cc ?? [], row.bcc ?? [], row.subject ?? "",
    row.body ?? "", row.html ?? null, row.inReplyToMessageId ?? row.inReplyTo ?? null,
  ]);
  /** Drafts whose send the server still holds `pending` — a discard or resolve on one answers 409. */
  const pendingSends = new Set<string>();
  let revision = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const raw = req.headers["idempotency-key"];
      const idem = typeof raw === "string" ? raw : null;
      seen.push({ method, url: url.pathname, body, key: idem });
      const heldAt = holds.findIndex((h) => h.method === method && url.pathname.startsWith(h.prefix));
      const held = heldAt >= 0 ? holds.splice(heldAt, 1)[0] : undefined;
      const json = (status: number, payload: unknown, syncSeq?: number) => {
        const answer = () => {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (syncSeq !== undefined) headers["x-sync-seq"] = String(syncSeq);
          res.writeHead(status, headers);
          res.end(JSON.stringify(payload));
        };
        if (held) held.arrive(answer); else answer();
      };
      const hung = hangs.findIndex((f) => f.method === method && url.pathname.startsWith(f.prefix));
      if (hung >= 0) {
        hangs.splice(hung, 1);
        return; // the connection stays open, no bytes ever come — the caller's deadline decides
      }
      const asked = queuedForOrganizer.findIndex((f) => f.method === method && url.pathname.startsWith(f.prefix));
      if (asked >= 0) {
        const [q] = queuedForOrganizer.splice(asked, 1);
        const id = url.pathname.split("/")[2] ?? "";
        json(202, {
          pending: true,
          requestId: "req-1",
          // The holder shape the database package defines — kind, name, since.
          holder: { kind: "local", name: q!.holder, since: "2026-09-01T09:00:00.000Z" },
          dto: messages.get(id) ?? null,
        });
        return;
      }
      const armed = failures.findIndex((f) => f.method === method && url.pathname.startsWith(f.prefix));
      if (armed >= 0) {
        const [f] = failures.splice(armed, 1);
        // Answer LATE, so the optimistic overlay has an observable window before the
        // rollback — a loopback refusal otherwise completes inside one macrotask and the
        // pre-rejection assertion races the wire. 422 is the hard refusal; an armed 500 is
        // the RETRYABLE one, for the queue-and-flush paths.
        setTimeout(() => json(f!.status ?? 422, f!.body ?? { error: { code: f!.status === 500 ? "server_error" : "invalid", message: "refused by test" } }), 25);
        return;
      }

      if (url.pathname === "/sync/snapshot") {
        json(200, { asOfSeq: seq, changes: log.map((ch) => ({ ...ch, seq })), nextCursor: null, window: { days: 90, minRows: 5000 } });
        return;
      }
      if (url.pathname === "/sync") {
        const since = url.searchParams.get("since") ?? "0";
        const from = since === "0" ? 0 : Number(Buffer.from(since, "base64url").toString("utf8").replace(/^seq:/, ""));
        const changes = log.filter((ch) => ch.seq > (Number.isFinite(from) ? from : 0));
        json(200, {
          changes: { creates: changes, updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(Math.max(Number.isFinite(from) ? from : 0, ...changes.map((c) => c.seq), 0)),
          hasMore: false,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      if (method === "PATCH" && url.pathname === "/messages") {
        const parsed = JSON.parse(body) as { ids: string[]; unread: boolean; openRead?: boolean };
        // The server's open-read rule (`MessageService.markSeen`): with `openRead`, the rows that
        // WERE unread take `openReadAt`, only when every id is one conversation; every unread clears it.
        const at = new Date().toISOString();
        const held = parsed.ids.map((id) => messages.get(id)).filter((m): m is Dto => m !== undefined);
        const oneConversation = new Set(held.map((m) => m.threadId ?? `msg:${m.id}`)).size === 1;
        const stamp = new Set(parsed.openRead === true && !parsed.unread && oneConversation
          ? held.filter((m) => m.unread && ((m.triage as { state?: string } | null)?.state ?? "none") === "none").map((m) => m.id) : []);
        for (const id of parsed.ids) {
          updateMessage(id, {
            unread: parsed.unread, lastReadAt: parsed.unread ? null : at,
            ...(parsed.unread ? { openReadAt: null } : stamp.has(id) ? { openReadAt: at } : {}),
          });
        }
        json(200, {}, seq);
        return;
      }
      if (method === "GET" && url.pathname === "/consent") {
        json(200, {
          foldersEnabledAt,
          // All three or none — see {@link screening}.
          ...(screening !== undefined ? screening : {}),
          // Absent when unset — the pre-0075 server's own answer shape.
          ...(signatures !== undefined ? { signatures } : {}),
          // Same rule for the face: absent = an API that cannot store one.
          ...(themeFace !== undefined ? { themeFace } : {}),
          ...(blockAutoUnsubscribeAt !== undefined ? { blockAutoUnsubscribeAt } : {}),
          ...(seedConfirmedAt !== undefined ? { seedConfirmedAt } : {}),
        });
        return;
      }
      /* `GET /consent/seed` answers the review; `POST` writes one `seeded-from-sent` INBOX rule per
         address that has none, stamps the confirm and answers `confirmSeed`'s counts. */
      if (url.pathname === "/consent/seed" && method === "GET") {
        json(200, seedReview);
        return;
      }
      if (url.pathname === "/consent/seed" && method === "POST") {
        const addresses = (JSON.parse(body || "{}") as { addresses?: string[] }).addresses ?? [];
        let rulesCreated = 0;
        for (const a of addresses) {
          if ([...rules.values()].some((r) => r.kind === "sender" && r.match === a)) continue;
          addRule({ ...ruleDto(`rule-seed-${seq + 1}`, "sender", a, "INBOX"), provenance: "seeded-from-sent" } as RuleDTO);
          rulesCreated += 1;
        }
        seedConfirmedAt = new Date().toISOString();
        json(200, { rulesCreated, contactsCreated: addresses.length, declined: 0, skipped: addresses.length - rulesCreated }, seq);
        return;
      }
      /* ── the two body reads, in the API's own answer shapes ───────────────────────────────
       *
       * ADDED BECAUSE THEIR ABSENCE WAS LOAD-BEARING. This fake served no body route at all, so
       * every hydration in every mobile suite ended in the 404 arm and `failed` was the only
       * outcome any of them had ever seen. A client-side defect between a 200 and a rendered
       * body was therefore invisible here by construction — which is exactly the defect the
       * Android walk found. The shapes are copied from a live `GET /messages/:id/body` and
       * `GET /messages/bodies?ids=…`: the single route also answers `headers` (dropped by the
       * client) and NEITHER answers `withheld`, which is what an ordinary row looks like.
       */
      const filesRoute = url.pathname.match(/^\/messages\/([^/]+)\/attachments$/);
      // Served only for a message given a list: every other list read answers as it always did.
      if (method === "GET" && filesRoute && files.has(decodeURIComponent(filesRoute[1]!))) {
        const id = decodeURIComponent(filesRoute[1]!);
        json(200, { items: (files.get(id) ?? []).map((f) => ({ ...f, messageId: id })) });
        return;
      }
      if (method === "GET" && url.pathname === "/hello" && helloFeatures !== null) {
        json(200, { product: "ohmail", flavor: "selfhost", apiVersion: "1", needsSetup: false, features: helloFeatures });
        return;
      }
      const bodyRoute = url.pathname.match(/^\/messages\/([^/]+)\/body$/);
      if (method === "GET" && bodyRoute) {
        const id = decodeURIComponent(bodyRoute[1]!);
        const text = bodies.get(id);
        if (text === undefined) { json(404, { error: { code: "not_found", message: "no body" } }); return; }
        const marker = withheld.get(id);
        json(200, {
          messageId: id, text, html: htmls.get(id) ?? null, ...(marker ? { withheld: marker } : {}),
          headers: { subject: [messages.get(id)?.subject ?? ""] },
          loadedRemoteContent: false, unsubscribe: postures.get(id) ?? "no_header", unsubscribeUrl: null,
        });
        return;
      }
      if (method === "GET" && url.pathname === "/messages/bodies") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => decodeURIComponent(s)).filter(Boolean);
        json(200, {
          items: ids.filter((id) => bodies.has(id)).map((id) => ({
            messageId: id, text: bodies.get(id), html: htmls.get(id) ?? null,
            loadedRemoteContent: false, unsubscribe: postures.get(id) ?? "no_header", unsubscribeUrl: null,
          })),
          nextCursor: null,
        });
        return;
      }
      /* ── the stage-2 folder verb routes — the API's own shapes (FOLDERS-SPEC.md §18) ───── */
      if (method === "POST" && url.pathname === "/folders") {
        const parsed = JSON.parse(body) as { mailboxId: string; name: string };
        const row: FolderRow = {
          id: `f-${seq + 1}`, name: parsed.name, mailboxId: parsed.mailboxId,
          mailbox: "owner@fake.test", updatedAt: new Date().toISOString(),
          op: { kind: "create" },
        };
        folders.set(row.id, row);
        push("folder", "create", row.id, row);
        json(200, row, seq);
        return;
      }
      const folderRoute = url.pathname.match(/^\/folders\/([^/]+)(?:\/(op|summary))?$/);
      if (folderRoute) {
        const id = decodeURIComponent(folderRoute[1]!);
        const held = folders.get(id);
        if (method === "GET" && folderRoute[2] === "summary") {
          if (!held || summaryCounts === null) { json(404, { error: { code: "not_found", message: "no summary" } }); return; }
          json(200, summaryCounts);
          return;
        }
        if (!held) { json(404, { error: { code: "not_found", message: "no such folder" } }); return; }
        if (method === "PATCH" && !folderRoute[2]) {
          const parsed = JSON.parse(body) as { name: string };
          const next: FolderRow = { ...held, op: { kind: "rename", to: parsed.name }, updatedAt: new Date().toISOString() };
          folders.set(id, next);
          push("folder", "update", id, next);
          json(200, next, seq);
          return;
        }
        if (method === "DELETE" && !folderRoute[2]) {
          const next: FolderRow = { ...held, op: { kind: "delete" }, updatedAt: new Date().toISOString() };
          folders.set(id, next);
          push("folder", "update", id, next);
          json(200, next, seq);
          return;
        }
        if (method === "DELETE" && folderRoute[2] === "op") {
          if (!held.op || held.op.error === undefined) { json(404, { error: { code: "not_found", message: "no failed op" } }); return; }
          if (held.op.kind === "create") {
            folders.delete(id);
            push("folder", "delete", id, null);
            json(200, { dismissed: true }, seq);
            return;
          }
          const { op: _op, ...settled } = held;
          const next = { ...settled, updatedAt: new Date().toISOString() } as FolderRow;
          folders.set(id, next);
          push("folder", "update", id, next);
          json(200, next, seq);
          return;
        }
      }
      if (method === "PATCH" && url.pathname === "/consent/settings") {
        /* PER-FIELD, BY PRESENCE — the real route's own contract (`packages/api/src/routes/
           consent.ts` tests every axis with `in`, so an omitted key means "leave this alone",
           and the echo carries only what was written). A fake that demanded one particular
           field would make every OTHER control's one-axis body look like a 400, which is the
           opposite of the property the one-axis rule exists to have. */
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        if ("foldersEnabled" in parsed) {
          if (typeof parsed.foldersEnabled !== "boolean") {
            json(400, { error: { code: "validation_failed", message: "foldersEnabled must be true or false" } });
            return;
          }
          foldersEnabledAt = parsed.foldersEnabled ? new Date().toISOString() : null;
          out.foldersEnabledAt = foldersEnabledAt;
        }
        if ("themeFace" in parsed) {
          const f = parsed.themeFace;
          if (f !== null && f !== "paper" && f !== "ohmarchy") {
            json(400, { error: { code: "validation_failed", message: "themeFace must be one of paper, ohmarchy, or null" } });
            return;
          }
          // `declineFace` is the ONE configuration in which the echo discipline can be observed
          // at all: a server that always stores what it is told is satisfied identically by a
          // client that echoes its own argument.
          if (!declineFace) themeFace = f;
          out.themeFace = themeFace ?? null;
        }
        if (Object.keys(out).length === 0) {
          json(400, { error: { code: "validation_failed", message: "no known setting named" } });
          return;
        }
        json(200, out);
        return;
      }
      if (method === "GET" && url.pathname === "/messages" && url.searchParams.get("view") === "trash") {
        // One page of the server's Trash, newest deletion first — the keyset the real route
        // walks, cut by `limit`, with a plain-offset cursor (opaque to the client either way).
        const rows = [...trash.values()].sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
        const from = Number(url.searchParams.get("cursor") ?? "0") || 0;
        const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
        const pageRows = rows.slice(from, from + limit);
        json(200, {
          items: pageRows.map((r) => ({ ...r.dto, trashedAt: r.trashedAt, restoreTo: r.restoreTo })),
          nextCursor: from + limit < rows.length ? String(from + limit) : null,
        });
        return;
      }
      const perMessage = url.pathname.match(/^\/messages\/([^/]+)(?:\/(move|triage|restore))?$/);
      if (perMessage) {
        const id = decodeURIComponent(perMessage[1]!);
        if (method === "DELETE" && !perMessage[2]) {
          // DELETE /messages/:id (mail 0065): the row leaves every living view — the change
          // log gets ONE delete tombstone — and the response echoes the message DTO with the
          // seq, exactly the shape the engine's adapter reads. The physical ride to \Trash is
          // the worker's; this fake has no folders to move between.
          const held = messages.get(id);
          if (!held) { json(404, { error: { code: "not_found", message: "no such message" } }); return; }
          messages.delete(id);
          // The server's Trash gains the row as the mirror loses it — the restore's source.
          trash.set(id, { dto: held, trashedAt: new Date().toISOString(), restoreTo: held.folder });
          push("message", "delete", id, null);
          json(200, { ...held, updatedAt: new Date().toISOString() }, seq);
          return;
        }
        if (method === "POST" && perMessage[2] === "restore") {
          // POST /messages/:id/restore — the delete's inverse move. Answers the SERVER's
          // resolved target and `pending: true` (the mail server moves it on the next pass),
          // and puts the row back on the change log so the next drain re-mirrors it.
          const binned = trash.get(id);
          if (!binned) { json(409, { error: { code: "not_in_trash", message: "not in Trash" } }); return; }
          trash.delete(id);
          const back = { ...binned.dto, updatedAt: new Date().toISOString() };
          messages.set(id, back);
          push("message", "create", id, back);
          json(200, { restoreTo: binned.restoreTo, pending: true }, seq);
          return;
        }
        if (method === "PATCH" && !perMessage[2]) {
          updateMessage(id, { unread: false, lastReadAt: new Date().toISOString() });
          json(200, messages.get(id), seq);
          return;
        }
        if (method === "POST" && perMessage[2] === "move") {
          const parsed = JSON.parse(body) as { folder: string };
          updateMessage(id, { folder: parsed.folder });
          json(200, messages.get(id), seq);
          return;
        }
        if (method === "POST" && perMessage[2] === "triage") {
          const parsed = JSON.parse(body) as { state: string; bubbleUpAt?: string };
          const iso = new Date().toISOString();
          const state = { messageId: id, state: parsed.state, bubbleUpAt: parsed.bubbleUpAt ?? null, setAt: iso, updatedAt: iso };
          push("message_state", "create", `st-${id}-${seq + 1}`, state);
          // The server's rule (`TriageService.setState`): a pile or a pin ends the open read. Only a
          // stamped row is re-emitted, carrying its state as the real DTO does.
          if (parsed.state !== "none" && messages.get(id)?.openReadAt) updateMessage(id, { openReadAt: null, triage: state as never });
          json(200, state, seq);
          return;
        }
      }
      /**
       * `GET /screener` — THE QUEUE, DERIVED THE WAY THE REAL SERVICE DERIVES IT: mail
       * physically in `ohmail/Screener`, one row per sender, the newest message representing it,
       * newest first (`screener-service.ts#list`, `heldSenderPage`). It consults NO rules, which
       * is the whole point of the double — the real service does not either, and a fake that
       * quietly excluded a ruled sender would agree with the client's defect instead of
       * measuring it. `pageSize` cuts the same keyset the real route cuts, so the client's
       * paging is driven rather than assumed.
       */
      if (method === "GET" && url.pathname === "/screener") {
        const held = [...messages.values()].filter((m) => m.folder === "ohmail/Screener");
        const bySender = new Map<string, Dto>();
        for (const m of held) {
          const key = m.from.address.toLowerCase();
          const rep = bySender.get(key);
          if (!rep || String(m.date ?? "") > String(rep.date ?? "")) bySender.set(key, m);
        }
        const rows = [...bySender.values()].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
        const after = url.searchParams.get("cursor");
        const from = after === null ? 0 : Number(after);
        const page = rows.slice(from, from + screenerPageSize);
        const nextCursor = from + screenerPageSize < rows.length ? String(from + screenerPageSize) : null;
        json(200, {
          items: page.map((m) => ({
            id: m.id, messageId: m.id, threadId: m.threadId ?? null,
            sender: { name: m.from.name ?? null, address: m.from.address },
            subject: m.subject, snippet: m.snippet ?? "",
            receivedAt: m.date ?? "", aiSuggestion: null, updatedAt: m.updatedAt ?? m.date ?? "",
          })),
          nextCursor,
          // The store's own count, stated on the first page only — the route's shape since it
          // began answering the whole queue's size.
          ...(after === null ? { total: rows.length } : {}),
          suggestable: { senders: [], credits: 0, maxPerRequest: 20, recommendedPerRequest: 10 },
          pendingDecisions,
        }, seq);
        return;
      }
      /**
       * `GET` / `POST /screener/unscreened` — INBOX mail from senders nobody ever decided about, as
       * `ohbox-unscreened-service.ts` answers it: one group per sender no enabled term-free rule
       * names, largest first; the press moves the named groups (all shown when none are named) to
       * the Screener and answers what it moved, and a second press finds nothing.
       */
      if (url.pathname === "/screener/unscreened" && (method === "GET" || method === "POST")) {
        const decided = (address: string): boolean => [...rules.values()].some((r) => r.enabled
          && !r.subjectContains && !r.bodyContains
          && (r.kind === "sender" ? r.match.toLowerCase() === address : r.kind === "domain" && r.match.toLowerCase() === address.split("@")[1]));
        const bySender = new Map<string, Dto[]>();
        const undecided = [...messages.values()].filter((m) => m.folder === "INBOX" && !decided(m.from.address.toLowerCase()));
        // The service's walk stops at its bound and says so (`complete: false`).
        const walked = unscreenedBound === null ? undecided : undecided.slice(0, unscreenedBound);
        for (const m of walked) {
          const key = m.from.address.toLowerCase();
          bySender.set(key, [...(bySender.get(key) ?? []), m]);
        }
        const groups = [...bySender.entries()]
          .map(([address, list]) => ({ address, count: list.length, newestAt: list.map((m) => String(m.date ?? "")).sort().at(-1) ?? "" }))
          .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
        if (method === "GET") {
          json(200, { groups, total: groups.reduce((n, g) => n + g.count, 0), complete: walked.length === undecided.length, max: 200 }, seq);
          return;
        }
        const named = (JSON.parse(body || "{}") as { addresses?: string[] }).addresses;
        const screened = named === undefined ? groups : groups.filter((g) => named.includes(g.address));
        for (const g of screened) for (const m of bySender.get(g.address) ?? []) updateMessage(m.id, { folder: "ohmail/Screener" });
        json(200, { screened, total: screened.reduce((n, g) => n + g.count, 0) }, seq);
        return;
      }
      /**
       * `GET /screener/stayed?ids=` — the route's shape (`routes/screener.ts`): at most 100 ids,
       * only this account's rows the facts classify answered, the rest left out.
       */
      if (method === "GET" && url.pathname === "/screener/stayed") {
        const raw = url.searchParams.get("ids") ?? "";
        const ids = raw === "" ? [] : raw.split(",");
        // The route's and the service's refusals: over 100 ids, or an id that is not a message id.
        if (raw.length > 100 * 37 || ids.length > 100 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
          json(400, { error: { code: "validation_failed", message: "at most 100" + " message ids" } });
          return;
        }
        const stayed = ids.filter((id) => messages.has(id) && stayedWhy.has(id)).map((id) => ({ id, why: stayedWhy.get(id) }));
        json(200, { stayed, max: 100 }, seq);
        return;
      }
      const screener = url.pathname.match(/^\/screener\/([^/]+)$/);
      if (screener && method === "POST") {
        const rep = messages.get(decodeURIComponent(screener[1]!));
        if (!rep || rep.folder !== "ohmail/Screener") {
          json(404, { error: { code: "not_found", message: "not held at the gate" } });
          return;
        }
        const parsed = JSON.parse(body) as { decision: "yes" | "no"; dest?: string; scope?: "sender" | "domain" };
        const dest = parsed.dest ?? (parsed.decision === "yes" ? "INBOX" : "ohmail/Screened");
        const key = rep.from.address.toLowerCase();
        for (const m of [...messages.values()]) {
          if (m.folder === "ohmail/Screener" && m.from.address.toLowerCase() === key) updateMessage(m.id, { folder: dest });
        }
        const scope = parsed.scope ?? "sender";
        const match = scope === "domain" ? key.split("@")[1]! : key;
        // `applyScreenerDecision`: one rule per key. The ACTING row under the bare key takes the
        // decision and its twins go; a key with no row gets the promoted one.
        const under = [...rules.values()].filter((r) => r.kind === scope && r.match.trim().toLowerCase() === match
          && !r.subjectContains && !r.bodyContains);
        const acting = twinWinner(under.filter((r) => r.enabled)) ?? under[0];
        if (acting === undefined) addRule(ruleDto(`rule-${seq + 1}`, scope, match, dest));
        else {
          for (const r of under) if (r.id !== acting.id) { rules.delete(r.id); push("rule", "delete", r.id, null); }
          const next = { ...acting, destination: dest, enabled: true, updatedAt: new Date().toISOString() } as RuleDTO;
          rules.set(next.id, next);
          push("rule", "update", next.id, next);
        }
        json(200, { messageId: rep.id, appliedFolder: dest }, seq);
        return;
      }
      if (method === "POST" && url.pathname === "/drafts") {
        const again = idem === null ? undefined : createdByKey.get(idem);
        // Production's middleware: a different body under a stored key is refused as idempotency_replay.
        if (again !== undefined && idem !== null && createHash.get(idem) !== body) {
          json(409, { error: { code: "idempotency_replay", message: "idempotency key reused with a different request" } });
          return;
        }
        if (again !== undefined && drafts.has(again)) { json(200, drafts.get(again), seq); return; }
        const parsed = JSON.parse(body) as Record<string, unknown>;
        draftSeq += 1;
        const at = new Date().toISOString();
        const row = { id: `d-${draftSeq}`, ...(stampedDrafts ? { status: "draft", createdAt: at, updatedAt: at } : {}), ...parsed, bcc: parsed.bcc ?? [] };
        drafts.set(row.id, row);
        if (idem !== null) { createdByKey.set(idem, row.id); createHash.set(idem, body); }
        // The route's own change: the row reaches the mirror on the next drain, as every write's does.
        push("draft", "create", row.id, row);
        json(200, row, seq);
        return;
      }
      /**
       * THE HELD-SEND DOORS, as `DraftsService` answers them. `DELETE` is 204 with the seq, or 409
       * `send_recorded` while a send is `pending`; `resolve` moves the row to `sent` / `draft` and
       * refuses a pending send as `send_still_running`; `PUT` writes what a bound send carries and
       * echoes the row with a fresh `contentRevision`, the version the send then vouches for.
       */
      const draftRoute = url.pathname.match(/^\/drafts\/([^/]+)(\/resolve)?$/);
      if (draftRoute && (method === "DELETE" || method === "PUT" || (method === "POST" && draftRoute[2]) || (method === "GET" && !draftRoute[2]))) {
        const id = decodeURIComponent(draftRoute[1]!);
        const row = drafts.get(id);
        if (!row) { json(404, { error: { code: "not_found", message: "draft not found" } }); return; }
        if (method === "GET") { json(200, { status: "draft", ...row }); return; }
        if (method === "DELETE") {
          if (pendingSends.has(id)) {
            json(409, { error: { code: "send_recorded", message: "this message is still being sent, or its send is still being confirmed; try again in a few minutes" } });
            return;
          }
          drafts.delete(id);
          push("draft", "delete", id, null);
          res.writeHead(204, { "x-sync-seq": String(seq) });
          res.end();
          return;
        }
        if (method === "POST") {
          if (pendingSends.has(id)) {
            json(409, { error: { code: "send_still_running", message: "this send may still be running" } });
            return;
          }
          const { outcome } = JSON.parse(body) as { outcome?: string };
          const next = { ...row, status: outcome === "arrived" ? "sent" : "draft", updatedAt: new Date().toISOString() };
          drafts.set(id, next);
          push("draft", "update", id, next);
          json(200, next, seq);
          return;
        }
        const patch = JSON.parse(body) as Record<string, unknown>;
        /* THE BELT, as `DraftsService.update` answers it: a row a send holds takes no new words. A sent
           row restated with its own words answers 200 unchanged; `unbelted` is the older server. */
        if (!unbelted && (row.status === "sending" || row.status === "unverified")) {
          json(409, { error: { code: "send_recorded", message: "this message has a send on record; resolve it before editing it" } });
          return;
        }
        if (!unbelted && row.status === "sent") {
          const same = Object.entries(patch).every(([k, v]) =>
            JSON.stringify((row as Record<string, unknown>)[k] ?? (k === "forwardOfMessageId" ? null : undefined)) === JSON.stringify(v));
          if (same) { json(200, row, seq); return; }
          json(409, { error: { code: "draft_sent", message: "this message has already been sent; its words cannot be changed" } });
          return;
        }
        /* THE VERSION CHECK, as `DraftsService.update` answers it: a stated version the row has moved off
           refuses the edit; one restating the row's words answers as written. */
        const { ifContentRevision: stated, ...words } = patch as Record<string, unknown> & { ifContentRevision?: string };
        if (stated !== undefined && stated !== row.contentRevision) {
          const same = Object.entries(words).every(([k, v]) => JSON.stringify((row as Record<string, unknown>)[k] ?? null) === JSON.stringify(v ?? null));
          if (same) { json(200, row, seq); return; }
          json(409, { error: { code: "draft_changed", message: "this draft was changed in another window or on another device; nothing was saved" } });
          return;
        }
        revision += 1;
        const next = { ...row, ...words, contentRevision: `rev-${revision}`, updatedAt: new Date().toISOString() };
        drafts.set(id, next);
        push("draft", "update", id, next);
        json(200, next, seq);
        return;
      }
      /**
       * SEND LATER (mail 0077) — the appointment routes, as `ScheduleService` answers them.
       * `POST` writes `send_at` + `status:'scheduled'` and dials NOTHING; `DELETE` takes the
       * appointment off and answers 409 "already being sent" once the claim window is armed
       * ({@link claimScheduled}), which is the one outcome the phone's cancel must not
       * mistake for a cancellation.
       */
      const draftSchedule = url.pathname.match(/^\/drafts\/([^/]+)\/schedule$/);
      if (draftSchedule) {
        const id = decodeURIComponent(draftSchedule[1]!);
        const row = drafts.get(id);
        if (!row) { json(404, { error: { code: "not_found", message: "no such draft" } }); return; }
        if (method === "POST") {
          // A row past the appointment lifecycle is refused, as `ScheduleService.schedule` refuses it.
          if (row.status !== undefined && row.status !== "draft" && row.status !== "scheduled") {
            json(409, { error: { code: "conflict", message: `draft cannot be scheduled from status '${String(row.status)}'` } });
            return;
          }
          const parsed = JSON.parse(body) as { sendAt?: string };
          // Future-only against the SERVER's clock — the real service's own precondition.
          if (!parsed.sendAt || Date.parse(parsed.sendAt) <= Date.now()) {
            json(422, { error: { code: "invalid", message: "sendAt must be in the future" } });
            return;
          }
          seq += 1;
          const next = { ...row, status: "scheduled", sendAt: parsed.sendAt, updatedAt: new Date().toISOString() };
          drafts.set(id, next);
          json(200, next, seq);
          return;
        }
        if (method === "DELETE") {
          if (claimed.has(id)) {
            json(409, { error: { code: "conflict", message: "this message is already being sent" } });
            return;
          }
          seq += 1;
          const next = { ...row, status: "draft", sendAt: null, updatedAt: new Date().toISOString() };
          drafts.set(id, next);
          json(200, next, seq);
          return;
        }
      }
      if (method === "POST" && url.pathname === "/sends/withdraw" && withdrawRoute) {
        // `SendService.withdraw` over this ledger: a held key answers its row, any other is tombstoned.
        if (idem === null) { json(400, { error: { code: "validation_failed", message: "Idempotency-Key header is required" } }); return; }
        const sent = sentByKey.get(idem);
        if (sent !== undefined) { json(200, { outcome: "already_sent", firstSend: { status: "sent", at: new Date().toISOString() } }); return; }
        if (failedSendKeys.has(idem)) { json(200, { outcome: "failed" }); return; }
        withdrawnKeys.add(idem);
        json(200, { outcome: "withdrawn" });
        return;
      }
      const draftSend = url.pathname.match(/^\/drafts\/([^/]+)\/send$/);
      if (draftSend && method === "POST") {
        const row = drafts.get(decodeURIComponent(draftSend[1]!));
        if (!row) { json(404, { error: { code: "not_found", message: "no such draft" } }); return; }
        if (idem !== null && withdrawnKeys.has(idem)) {
          json(409, { error: { code: "send_withdrawn", message: "This send was cancelled before it left; nothing was sent.", retryable: false } });
          return;
        }
        // The reservation answers before anything is dialled — see {@link sentByKey}. A replay
        // carries `firstSend`, as the real route does: the answer is otherwise the same shape a
        // fresh send returns, and that is exactly what a client cannot tell apart on its own.
        if (idem !== null && failedSendKeys.has(idem)) {
          json(409, { status: "failed", message: "A prior send under this key failed and was not delivered." });
          return;
        }
        if (sendsOffline && idem !== null) {
          failedSendKeys.add(idem);
          json(500, { error: { code: "internal", message: "internal error" } });
          return;
        }
        const held = idem === null ? undefined : sentByKey.get(idem);
        if (held !== undefined && againSentKeys.has(idem!)) { json(200, held, seq); return; }
        if (held !== undefined) {
          json(200, { ...(held as Record<string, unknown>), firstSend: { status: "sent", at: new Date().toISOString() } }, seq);
          return;
        }
        // SEND AGAIN of a held row (`SendService.prepareAgain`): it goes again, under its own message.
        if (body !== "" && (JSON.parse(body) as { again?: unknown }).again === true) {
          if (row.status === "sending" || pendingSends.has(row.id as string)) {
            json(409, { error: { code: "send_again_in_flight", message: "This message is being sent right now.", retryable: false } });
            return;
          }
          if (row.status !== "unverified") {
            json(409, { error: { code: "send_again_not_held", message: "This message isn't waiting to be sent again.", retryable: false } });
            return;
          }
          if (unverifiedSends > 0) {
            unverifiedSends -= 1;
            json(200, { status: "unverified", message: "the transport did not confirm" }, seq);
            return;
          }
          const answer = { status: "sent", providerMessageId: `pm-${draftSend[1]!}` };
          if (idem !== null) { sentByKey.set(idem, answer); againSentKeys.add(idem); }
          drafts.set(row.id as string, { ...row, status: "sent" });
          if (againAnswersLost > 0) {
            againAnswersLost -= 1;
            json(202, { status: "queued", message: "This send was accepted and is still being handed to your mail server." });
            return;
          }
          json(200, answer, seq);
          return;
        }
        // A NEW key over a row past `draft` is refused, as `SendService.reserve` refuses it.
        if (row.status !== undefined && row.status !== "draft") {
          json(409, { error: { code: "conflict", message: `draft cannot be sent from status '${String(row.status)}'` } });
          return;
        }
        const firstAt = contentClaim ? deliveredContent.get(contentOf(row)) : undefined;
        if (firstAt !== undefined && Date.now() - firstAt < 60 * 60 * 1000) {
          if (idem !== null) duplicateKeys.push(idem);
          json(409, { error: {
            code: "duplicate_send", message: "This message was already sent.", retryable: false,
            details: { firstSend: { status: "sent", at: new Date(firstAt).toISOString() } },
          } });
          return;
        }
        if (unverifiedSends > 0) {
          unverifiedSends -= 1;
          // The 200-with-unverified answer the real route gives when SMTP's outcome is unknowable.
          json(200, { status: "unverified", message: "the transport did not confirm" }, seq);
          return;
        }
        const answer = { status: "sent", providerMessageId: `pm-${draftSend[1]!}` };
        if (idem !== null) sentByKey.set(idem, answer);
        if (contentClaim) deliveredContent.set(contentOf(row), Date.now());
        drafts.set(row.id as string, { ...row, status: "sent" });
        json(200, answer, seq);
        return;
      }
      const tagsRoute = url.pathname.match(/^\/messages\/([^/]+)\/tags$/);
      if (tagsRoute && method === "POST") {
        const held = messages.get(decodeURIComponent(tagsRoute[1]!));
        if (!held) { json(404, { error: { code: "not_found", message: "no such message" } }); return; }
        const parsed = JSON.parse(body) as { tagId: string; assigned: boolean; name?: string };
        if (parsed.name !== undefined) {
          push("tag", "create", parsed.tagId, {
            id: parsed.tagId, accountId: "acct-1", name: parsed.name, hue: "h1",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
        }
        const labels = new Set((held as Dto & { labels: string[] }).labels ?? []);
        if (parsed.assigned) labels.add(parsed.tagId);
        else labels.delete(parsed.tagId);
        updateMessage(held.id, { labels: [...labels] } as Partial<Dto>);
        json(200, {}, seq);
        return;
      }
      if (method === "GET" && url.pathname === "/organizer-requests") {
        json(200, { items: waitingRequests });
        return;
      }
      if (method === "POST" && url.pathname === "/rules") {
        const parsed = JSON.parse(body) as { kind: "sender" | "domain"; match: string; destination: string; priority?: number; applyRetro?: boolean };
        const r = {
          ...ruleDto(`rule-${seq + 1}`, parsed.kind, parsed.match, parsed.destination), priority: parsed.priority ?? 0,
          ...(stampRetro ? { retro: { requestedAt: parsed.applyRetro === false ? null : new Date().toISOString(), doneAt: null } } : {}),
        };
        addRule(r);
        json(200, r, seq);
        return;
      }
      const ruleRoute = url.pathname.match(/^\/rules\/([^/]+)$/);
      if (ruleRoute && method === "PATCH") {
        const held = rules.get(decodeURIComponent(ruleRoute[1]!));
        if (!held) { json(404, { error: { code: "not_found", message: "no such rule" } }); return; }
        const parsed = JSON.parse(body) as { destination: string; priority?: number; applyRetro?: boolean };
        // `RulesService.update`: the key converges onto the PATCHed row, so its twins go first.
        const keyOf = (r: RuleDTO) => JSON.stringify([r.kind, r.match.trim().toLowerCase(), r.subjectContains ?? null, r.bodyContains ?? null]);
        for (const r of [...rules.values()]) {
          if (r.id !== held.id && keyOf(r) === keyOf(held)) { rules.delete(r.id); push("rule", "delete", r.id, null); }
        }
        const next = {
          ...held, destination: parsed.destination, updatedAt: new Date().toISOString(),
          ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
          ...(stampRetro && parsed.applyRetro !== false ? { retro: { requestedAt: new Date().toISOString(), doneAt: null } } : {}),
        } as RuleDTO;
        rules.set(next.id, next);
        push("rule", "update", next.id, next);
        json(200, next, seq);
        return;
      }
      if (ruleRoute && method === "DELETE") {
        const id = decodeURIComponent(ruleRoute[1]!);
        rules.delete(id);
        push("rule", "delete", id, null);
        res.writeHead(204, { "x-sync-seq": String(seq) });
        res.end();
        return;
      }
      json(404, { error: { code: "not_found", message: "no such route" } });
    });
  });

  return {
    server, addMessage, addRule, addFolder, seen,
    /** Any change on /sync, as the server writes it — an entity this double has no verb for. */
    push,
    /** Keys a Cancel tombstoned on this server. */
    withdrawnKeys: (): string[] => [...withdrawnKeys],
    /** `false` turns the withdraw route off: a server that predates it answers 404. */
    setWithdrawRoute: (on: boolean) => { withdrawRoute = on; },
    /** `true`: the server's one-hour content claim refuses a second copy under a new key. */
    setContentClaim: (on: boolean) => { contentClaim = on; },
    /** The keys the content claim refused as a second copy (`duplicate_send`). */
    duplicates: (): string[] => [...duplicateKeys],
    /**
     * A THREAD ROW ON /sync, carrying the ids the SERVER holds — which is how a windowed mirror
     * can hold three of nine and still say nine (`threadSizeIndex`). The real thread DTO rides
     * with the page that names it; this is that entity, with the fields a client reads.
     */
    addThread: (id: string, messageIds: string[]) => {
      push("thread", "create", id, { id, accountId: "acct-1", messageIds, updatedAt: new Date().toISOString() });
    },
    /** A tag the account holds, made elsewhere — the `tag` entity the drain carries. */
    addTag: (id: string, name: string, hue: string) => {
      const at = new Date().toISOString();
      push("tag", "create", id, { id, accountId: "acct-1", name, hue, createdAt: at, updatedAt: at });
    },
    /** This message's attachment list — what `GET /messages/:id/attachments` then answers. */
    setFiles: (id: string, list: Array<{ id: string; filename: string; contentType: string; sizeBytes: number; inline?: boolean }>) => {
      files.set(id, list.map((f) => ({ ...f, inline: f.inline ?? false })));
    },
    /** Serve `GET /hello` with these `features`; `null` stops serving it (a 404). */
    setHello: (features: Record<string, unknown> | null) => { helloFeatures = features; },
    /** Give this message a stored body — what `GET /messages/:id/body` then answers. */
    setBody: (id: string, text: string, posture?: "one_click" | "no_header" | "mailto_only" | "not_one_click") => {
      bodies.set(id, text);
      if (posture) postures.set(id, posture);
    },
    /** Give this message a stored html part beside its text. */
    setHtml: (id: string, html: string) => { htmls.set(id, html); },
    /** Hold this message's body as a husk under `marker` — the single route answers it empty. */
    setWithheld: (id: string, marker: "storage_cap" | "junk_filed" | "expunged") => {
      bodies.set(id, ""); withheld.set(id, marker);
    },
    /** The consent row's folders flag, as the server holds it. */
    foldersOn: () => foldersEnabledAt !== null,
    setFoldersEnabledAt: (iso: string | null) => { foldersEnabledAt = iso; },
    /**
     * The account's cutline answer on `GET /consent`. `undefined` omits all three fields — the
     * pre-mail-0056 server's own answer shape, which the phone must read as "no answer".
     */
    setScreening: (
      s: { dormancyDays: number; screeningBaselineAt: string | null; screeningScope: string } | undefined,
    ) => { screening = s; },
    /** The consent row's signatures map (mail 0075); `undefined` = a pre-0075 server. */
    setSignatures: (map: Record<string, string> | undefined) => { signatures = map; },
    /**
     * The consent row's appearance face. `undefined` (the default) OMITS the field — a server
     * too old to store one; `null` is an account with no preference; a string is its choice.
     */
    setThemeFace: (face: string | null | undefined) => { themeFace = face; },
    /** The account's unsubscribe switch as `GET /consent` serves it; `undefined` omits the field. */
    setBlockAutoUnsubscribeAt: (at: string | null | undefined) => { blockAutoUnsubscribeAt = at; },
    /** `seedConfirmedAt` on `GET /consent`; `undefined` omits it. */
    setSeedConfirmedAt: (at: string | null | undefined) => { seedConfirmedAt = at; },
    /** What `GET /consent/seed` answers from now on. */
    setSeedReview: (review: unknown) => { seedReview = review; },
    /** The face as the account holds it — what a travel assertion reads. */
    themeFace: () => themeFace,
    /** Accept every face write and store none — see {@link declineFace}. */
    declineFaceWrites: (on: boolean) => { declineFace = on; },
    /** The summary route's answer; `null` (the default) keeps it a 404 — the uncounted path. */
    setSummary: (counts: { folders: number; messages: number } | null) => { summaryCounts = counts; },
    /** One folder row as the fake holds it — what the verb tests assert markers on. */
    folder: (id: string) => folders.get(id),
    /** A worker's settle, server-side: the op marker resolves and the change rides the drain. */
    settleFolder: (id: string, patch: Partial<FolderRow> & { failWith?: string }) => {
      const held = folders.get(id);
      if (!held) return;
      const { failWith, ...rest } = patch;
      const next: FolderRow = failWith !== undefined
        ? { ...held, op: { ...(held.op ?? { kind: "create" }), error: failWith }, updatedAt: new Date().toISOString() }
        : (() => { const { op: _op, ...settled } = { ...held, ...rest }; return { ...settled, updatedAt: new Date().toISOString() }; })();
      folders.set(id, next);
      push("folder", "update", id, next);
    },
    failNext: (method: string, prefix: string) => failures.push({ method, prefix }),
    /** Stops `GET /screener/unscreened`'s walk after `n` letters, as the service's bound does. */
    boundUnscreened: (n: number | null) => { unscreenedBound = n; },
    /**
     * The next matching request answers 202 with the organizer's request record — the reader
     * mailbox's door. `holder` is the install's name, or `null` for a real holder without one.
     */
    /** Rules written from now on answer their backlog pass as requested — see `finishRetro`. */
    stampRetro: (on: boolean) => { stampRetro = on; },
    /** The organizer's pass over this rule's backlog ended (moving `moved` to its place): the rule's change carries `doneAt`. */
    finishRetro: (id: string, moved: readonly string[] = []) => {
      const held = rules.get(id);
      if (!held) throw new Error(`no rule ${id}`);
      for (const m of moved) updateMessage(m, { folder: held.destination } as Partial<Dto>);
      const next = { ...held, retro: { requestedAt: held.retro?.requestedAt ?? new Date().toISOString(), doneAt: new Date().toISOString() }, updatedAt: new Date().toISOString() } as RuleDTO;
      rules.set(id, next);
      push("rule", "update", id, next);
    },
    /** What `GET /organizer-requests` answers from now on. */
    setWaitingRequests: (items: unknown[]) => { waitingRequests = items; },
    queueNextForOrganizer: (method: string, prefix: string, holder: string | null = "Studio laptop") =>
      queuedForOrganizer.push({ method, prefix, holder }),
    /** The next matching request is accepted and NEVER answered — the hung-server shape. */
    hangNext: (method: string, prefix: string) => hangs.push({ method, prefix }),
    /**
     * The next matching request is handled at once and ANSWERED only when the returned release
     * is called — a slow response the test times itself. Releasing before the request lands is
     * allowed: it answers the moment it does.
     */
    holdNext: (method: string, prefix: string): (() => void) => {
      let answer: (() => void) | null = null;
      let released = false;
      holds.push({ method, prefix, arrive: (a) => { if (released) a(); else answer = a; } });
      return () => { released = true; const a = answer; answer = null; a?.(); };
    },
    failNextStatus: (method: string, prefix: string, status: number) => failures.push({ method, prefix, status }),
    /** The next matching request answers exactly this status and body — a route's own refusal wire. */
    answerNext: (method: string, prefix: string, status: number, body: unknown) => failures.push({ method, prefix, status, body }),
    /** Cut the network behind the send route (`sendsOffline`); `false` puts it back. */
    sendOffline: (on = true) => { sendsOffline = on; },
    /** Created rows carry their status and stamps, so a drain lists them in Drafts. */
    stampDrafts: (on = true) => { stampedDrafts = on; },
    /** Answer as a server without the sent-row belt: a PUT over a sent row rewrites it, 200. */
    unbeltedSentRows: (on = true) => { unbelted = on; },
    /** The next N sends answer 200 `{status:"unverified"}` — SMTP's unknowable outcome. */
    unverifiedNextSend: () => { unverifiedSends += 1; },
    /** The next Send again is taken, and its answer lost: 202 queued; its key's replay is the delivery. */
    loseNextAgainAnswer: () => { againAnswersLost += 1; },
    /** A draft row the account already holds, arriving on the next drain like any entity. */
    addDraft: (row: Record<string, unknown> & { id: string }) => { drafts.set(row.id, row); push("draft", "create", row.id, row); },
    /** Another device sent this draft: the row turns `sent` and rides the next drain with its text
     *  withheld, as `draftRowToSnapshotDTO` serves a sent row. */
    sendElsewhere: (id: string) => {
      const row = drafts.get(id);
      if (!row) throw new Error(`no draft ${id}`);
      const next = { ...row, status: "sent", updatedAt: new Date().toISOString() };
      drafts.set(id, next);
      push("draft", "update", id, { ...next, body: null, html: null, bodyOmitted: "sent" });
    },
    /** Another device deleted this draft: the row is gone and the delete rides the next drain. */
    deleteElsewhere: (id: string) => {
      if (!drafts.delete(id)) throw new Error(`no draft ${id}`);
      push("draft", "delete", id, null);
    },
    /** The server holds a `pending` send for this draft: discard and resolve answer 409 by name. */
    pendSend: (id: string, on = true) => { if (on) pendingSends.add(id); else pendingSends.delete(id); },
    /** One draft row as the fake holds it — what the Send-later tests assert the appointment on. */
    draft: (id: string) => drafts.get(id),
    /** Every draft the fake holds, in creation order. */
    draftRows: () => [...drafts.values()],
    /** The Idempotency-Keys this server actually delivered under — one entry per message sent. */
    deliveries: () => [...sentByKey.keys()],
    /** The scheduled-send pass got there first: a cancel on this row now answers 409. */
    claimScheduled: (id: string) => { claimed.add(id); },
    /** Cut `GET /screener` into pages of this size, so the client's cursor loop is measured. */
    setScreenerPageSize: (n: number) => { screenerPageSize = n; },
    setPendingDecisions: (list: unknown[]) => { pendingDecisions = list; },
    holdOnServer,
    currentSeq: () => seq,
    message: (id: string) => messages.get(id),
    rule: (id: string) => rules.get(id),
    /** Name why this row stayed — what `GET /screener/stayed` then answers for it. */
    setStayed: (id: string, why: "failed-checks" | "set-aside" | "replied" | "filed-elsewhere") => { stayedWhy.set(id, why); },
    /** Another client's act, server-side: the change rides the next /sync drain. */
    update: (id: string, patch: Partial<Dto>) => updateMessage(id, patch),
  };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}
