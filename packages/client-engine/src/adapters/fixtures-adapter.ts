import {
  getFixtures,
  tagsOf,
  type Fixtures,
  type MessageFixture,
  type TriageItemFixture,
} from "@ohmail/fixtures";
import { applyToRecords, recordKey, type MirrorRecord } from "../apply.js";
import type { EntityReader } from "../store.js";
import { mutationEffects, type MutationEffect } from "../mutations.js";
import {
  CursorExpiredError,
  MutationRejectedError,
  decodeSeqCursor,
  encodeSeqCursor,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MessageStateDTO,
  type ScreenerSenderDTO,
  type SyncChange,
  type SyncResponse,
  type TriageItemDTO,
} from "../types.js";
import type { EngineAdapter, MutationOutcome, SyncParams } from "./adapter.js";

/** The demo world's fixed "now" — a Wednesday; "Tue" fixtures land the day before. */
export const DEMO_NOW = new Date("2026-07-29T12:00:00.000Z");

const FIXTURE_FOLDER: Record<MessageFixture["folder"], Folder> = {
  ohbox: "INBOX",
  reads: "ohmail/Reads",
  receipts: "ohmail/Receipts",
};

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;

/**
 * Turn a prototype display time ("09:12", "yesterday", "Mon") into a real
 * instant relative to `base`, strictly descending along the fixture array
 * (`index`) so mirror ordering (date desc) reproduces the prototype exactly.
 */
export function parseFixtureTime(time: string, index: number, base: Date): string {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (hm) {
    const d = new Date(base);
    d.setUTCHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d.toISOString();
  }
  if (time === "yesterday") {
    const d = new Date(base.getTime() - DAY_MS);
    d.setUTCHours(18, 0, 0, 0);
    return new Date(d.getTime() - index * 60_000).toISOString();
  }
  const weekday = WEEKDAY_SHORT.indexOf(time);
  if (weekday >= 0) {
    let diff = (base.getUTCDay() - weekday + 7) % 7;
    if (diff === 0) diff = 7; // "Mon" always means a PAST Monday
    const d = new Date(base.getTime() - diff * DAY_MS);
    d.setUTCHours(12, 0, 0, 0);
    return new Date(d.getTime() - index * 60_000).toISOString();
  }
  return new Date(base.getTime() - (2 + index) * DAY_MS).toISOString();
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface FixturesAdapterOptions {
  fixtures?: Fixtures;
  now?: () => Date;
  /** Id generator for entities minted by mutations (deterministic by default). */
  uuid?: () => string;
}

/**
 * The demo backend: boots the mirror from @ohmail/fixtures and serves mutations
 * locally with realistic protocol semantics — a real change log with monotonic
 * seqs, paged bootstrap (`hasMore` drain), tail deltas after every mutation,
 * malformed-cursor 410s, and Idempotency-Key replay. Powers ?demo and UI tests;
 * the Engine cannot tell it from the real server.
 */
export class FixturesAdapter implements EngineAdapter {
  private readonly world = new Map<string, MirrorRecord>();
  private readonly log: SyncChange[] = [];
  private readonly replays = new Map<string, MutationOutcome>();
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private seq = 0;

  constructor(opts: FixturesAdapterOptions = {}) {
    this.now = opts.now ?? (() => DEMO_NOW);
    let n = 0;
    this.uuid = opts.uuid ?? (() => `demo-${++n}`);
    this.buildWorld(opts.fixtures ?? getFixtures());
  }

  // ── the demo change log ──────────────────────────────────────────────────

  private emit(type: string, id: string, entity: unknown | null, move?: { from: Folder | null; to: Folder }): SyncChange {
    const prev = this.world.get(recordKey(type, id));
    const op = entity === null ? "delete" : move ? "move" : prev && prev.entity !== null ? "update" : "create";
    const change: SyncChange = {
      type,
      op,
      id,
      seq: ++this.seq,
      updatedAt: this.now().toISOString(),
      ...(entity === null ? {} : { entity }),
      ...(move ? { move } : {}),
    };
    this.log.push(change);
    applyToRecords(this.world, [change]);
    return change;
  }

  private reader(): EntityReader {
    const world = this.world;
    return {
      get: <T,>(type: string, id: string) => {
        const rec = world.get(recordKey(type, id));
        return rec && rec.entity !== null ? (rec.entity as T) : undefined;
      },
      list: <T,>(type: string) => {
        const out: T[] = [];
        for (const rec of world.values()) if (rec.type === type && rec.entity !== null) out.push(rec.entity as T);
        return out;
      },
      entries: <T,>(type: string) => {
        const out: Array<{ id: string; entity: T }> = [];
        for (const rec of world.values()) {
          if (rec.type === type && rec.entity !== null) out.push({ id: rec.id, entity: rec.entity as T });
        }
        return out;
      },
      version: () => this.seq,
    };
  }

  // ── world construction from the fixture dataset ──────────────────────────

  private toMessage(f: MessageFixture, index: number, triage: MessageStateDTO | null): EngineMessage {
    const iso = this.now().toISOString();
    const isProtected = f.protected != null;
    return {
      id: f.id,
      accountId: "demo",
      mailboxId: "lichtgrat",
      threadId: null,
      messageIdHeader: null,
      subject: f.subject,
      from: f.from,
      to: [],
      cc: [],
      date: parseFixtureTime(f.time, index, this.now()),
      folder: FIXTURE_FOLDER[f.folder],
      snippet: f.snippet ?? (isProtected ? "" : (f.body ?? "").split("\n")[0] ?? ""),
      unread: f.unread,
      hasAttachments: f.attachment != null,
      attachmentCount: f.attachment ? 1 : 0,
      sensitivity: isProtected
        ? { sensitive: true, category: "verification", no_ai: true, no_forward: true, no_kb: true, priority: false }
        : { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage,
      labels: tagsOf(f.id).map((t) => t.id),
      remoteContent: f.trackerNote ? "blocked" : "none",
      updatedAt: iso,
      time: f.time,
      ...(f.body !== undefined ? { body: f.body } : {}),
      ...(f.threadCount !== undefined ? { threadCount: f.threadCount } : {}),
      ...(f.attachment ? { attachment: f.attachment } : {}),
      ...(f.protected ? { protected: f.protected } : {}),
      ...(f.rationale !== undefined ? { rationale: f.rationale } : {}),
      ...(f.trackerNote !== undefined ? { trackerNote: f.trackerNote } : {}),
      ...(f.amount !== undefined ? { amount: f.amount } : {}),
      ...(f.art ? { art: f.art } : {}),
    };
  }

  private buildWorld(fx: Fixtures): void {
    const iso = this.now().toISOString();

    for (const mb of fx.mailboxes) this.emit("mailbox", mb.id, mb);
    for (const tag of fx.tags) {
      this.emit("tag", tag.id, { id: tag.id, name: tag.name, hue: tag.hue, className: tag.className });
    }

    // Triage: message-backed entries become message_state; orphans triage_item.
    const states = new Map<string, MessageStateDTO>();
    const pilesOf: Array<[TriageItemFixture[], TriageItemDTO["pile"]]> = [
      [fx.triage.replyLater, "reply_later"],
      [fx.triage.setAside, "set_aside"],
      [fx.triage.resurface, "bubbled_up"],
    ];
    for (const [items, pile] of pilesOf) {
      for (const item of items) {
        if (item.messageId) {
          states.set(item.messageId, {
            messageId: item.messageId,
            state: pile,
            bubbleUpAt: null,
            setAt: iso,
            updatedAt: iso,
          });
        } else {
          const entity: TriageItemDTO = {
            id: `${pile}:${slug(item.title)}`,
            pile,
            title: item.title,
            ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
            ...(item.preview !== undefined ? { preview: item.preview } : {}),
            ...(item.resurfaceAt !== undefined ? { resurfaceAt: item.resurfaceAt } : {}),
          };
          this.emit("triage_item", entity.id, entity);
        }
      }
    }

    for (const list of [fx.ohbox, fx.reads, fx.receipts]) {
      list.forEach((f, i) => {
        const msg = this.toMessage(f, i, states.get(f.id) ?? null);
        this.emit("message", msg.id, msg);
      });
    }
    for (const st of states.values()) this.emit("message_state", st.messageId, st);

    for (const w of fx.screener.waiting) {
      const entity: ScreenerSenderDTO = {
        id: w.id,
        segment: "waiting",
        from: w.from,
        initial: w.initial,
        time: w.time,
        scope: w.scope,
        ...(w.dull !== undefined ? { dull: w.dull } : {}),
        ai: w.ai,
        held: w.held,
        updatedAt: iso,
      };
      this.emit("screener_sender", entity.id, entity);
    }
    for (const s of fx.screener.screenedOut) {
      const entity: ScreenerSenderDTO = {
        id: `screened:${s.address}`,
        segment: "screened_out",
        from: { name: null, address: s.address },
        initial: (s.address[0] ?? "?").toUpperCase(),
        time: s.screenedOn,
        scope: "sender",
        ai: null,
        // Every held message, in full — never a count plus a newest body.
        held: s.held,
        screenedOn: s.screenedOn,
        updatedAt: iso,
      };
      this.emit("screener_sender", entity.id, entity);
    }
    fx.screener.spam.forEach((s, i) => {
      const entity: ScreenerSenderDTO = {
        id: `spam:${i}:${s.from}`,
        segment: "spam",
        from: { name: null, address: s.from },
        initial: (s.from[0] ?? "?").toUpperCase(),
        time: s.held[s.held.length - 1]!.time,
        scope: "sender",
        dull: true,
        ai: null,
        held: s.held,
        detection: s.detection,
        updatedAt: iso,
      };
      this.emit("screener_sender", entity.id, entity);
    });

    const draft: EngineDraft = {
      id: "draft-compose",
      mailboxId: "lichtgrat",
      threadId: null,
      inReplyToMessageId: "giulia",
      subject: fx.composeDraft.subject,
      body: fx.composeDraft.body,
      to: [fx.composeDraft.to],
      cc: [],
      bcc: [],
      rationale: fx.composeDraft.grounding,
      status: "draft",
      accepted: false,
      createdAt: iso,
      updatedAt: iso,
    };
    this.emit("draft", draft.id, draft);

    this.emit("view_meta", "reads_waterline", fx.readsWaterline);
    this.emit("view_meta", "reads_ai_chip", fx.readsAiChip);
    this.emit("view_meta", "account", fx.account);
    /**
     * The Notifications screen's VIP list and its learned suggestion.
     *
     * They used to be imported into `SettingsView` straight from `@ohmail/fixtures` and
     * rendered on every account, so a paying customer read a learned pattern about Petra Wyss
     * — a person invented for the demo. They travel through the MIRROR now, exactly as the
     * Reads waterline and the AI chip already do, which means the gate is structural: `/sync`
     * has no `view_meta` entity type at all, so a Cloud account can never receive this row and
     * the block simply does not render there. It is a stronger guarantee than a `demo` boolean
     * a view has to remember to check, and it keeps Mila's people where they belong — in the
     * fixtures package, not in the app's copy file.
     *
     * The channel LABELS deliberately do not travel with it: they are ordinary product copy
     * that a live account legitimately sees, and they live in `messages/en.json`.
     */
    this.emit("view_meta", "notifications", fx.notificationSettings);
  }

  // ── EngineAdapter ────────────────────────────────────────────────────────

  async sync(params: SyncParams): Promise<SyncResponse> {
    const since = decodeSeqCursor(params.since);
    if (since === null) throw new CursorExpiredError();
    const limit = Math.min(Math.max(1, params.limit ?? 500), 2000);
    const types = params.types ? new Set(params.types) : null;

    const pending = this.log.filter((c) => c.seq > since && (!types || types.has(c.type)));
    const page = pending.slice(0, limit);

    const buckets: SyncResponse["changes"] = { creates: [], updates: [], moves: [], deletes: [] };
    for (const c of page) {
      if (c.op === "create") buckets.creates.push(c);
      else if (c.op === "update") buckets.updates.push(c);
      else if (c.op === "move") buckets.moves.push(c);
      else buckets.deletes.push(c);
    }
    const last = page[page.length - 1];
    return {
      changes: buckets,
      cursor: encodeSeqCursor(last ? last.seq : since),
      hasMore: pending.length > page.length,
      serverTime: this.now().toISOString(),
    };
  }

  /**
   * NO BODIES TO FETCH — and that is the demo's correct answer, not a missing feature.
   *
   * `toMessage` copies the fixture's `body` straight onto the mirror row, so every message
   * in Mila's world already holds its full text and `bodyOf` answers `full` from the
   * message itself, before the engine ever reaches an adapter. The one fixture message with
   * no body is the protected verification code, which has none by design — sensitive mail is
   * stored redacted — and
   * whose surface renders `ProtectedBlock` rather than any text at all.
   *
   * `null` rather than `{text: ""}`: an empty string is a claim about the mail ("this
   * message is blank"), and the engine writes no record for a `null`, so a demo tab holds
   * no `message_body` rows and performs no requests at all, which is what a self-contained
   * surface has to mean.
   */
  async fetchBody(): Promise<null> {
    return null;
  }

  async mutate(m: EngineMutation, opts: { idempotencyKey: string }): Promise<MutationOutcome> {
    // Contract §1.6: same key ⇒ the stored outcome is replayed verbatim, never
    // re-executed — a retry after a lost response cannot double-apply.
    const replay = this.replays.get(opts.idempotencyKey);
    if (replay) return replay;

    const effects = mutationEffects(this.reader(), m, { now: this.now, uuid: this.uuid });
    if (effects.length === 0) {
      throw new MutationRejectedError(`mutation target not found (${m.kind})`, { status: 404, code: "not_found" });
    }
    const changes = effects.map((e: MutationEffect) => this.emit(e.type, e.id, e.entity, e.move));
    const outcome: MutationOutcome = {
      changes,
      seq: changes[changes.length - 1]!.seq,
      /**
       * THE CREATED ROW'S ID, for the one mutation whose caller has to keep using it.
       *
       * In the demo there is no server, so the effect's own client-minted id IS the row's id —
       * `emit` writes it into the fixture store under exactly that id. Answering `undefined` here
       * would leave the compose surface adopting nothing, and it would then CREATE a fresh draft
       * every two seconds for as long as somebody was typing. The demo would look correct
       * throughout, because a fixture store shows whatever it was last told; the cost would land
       * only where there is a database to fill with abandoned rows.
       */
      ...(m.kind === "draft_save" && m.draftId === null && effects[0]
        ? { entityId: effects[0].id }
        : {}),
    };
    this.replays.set(opts.idempotencyKey, outcome);
    return outcome;
  }
}
