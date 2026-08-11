import { senderKey } from "./selectors.js";
import type { EntityReader } from "./store.js";
import {
  FOLDER_OF_VIEW,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MessageStateDTO,
  type RuleDTO,
  type ScreenerSenderDTO,
  type TagDTO,
  type WaterlineMeta,
} from "./types.js";

/**
 * The reply subject for a parent subject — `Re: ` exactly once.
 *
 * CASE-INSENSITIVE, because the prefix arrives in whatever case the sender's client used
 * and a case-sensitive test yields `Re: RE: …` on the second exchange with an Outlook
 * correspondent. Only the leading prefix is stripped: `Re: Re: x` collapses to one, and a
 * subject that merely CONTAINS "re:" is untouched.
 */
export function replySubject(parentSubject: string): string {
  const bare = parentSubject.replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  return bare ? `Re: ${bare}` : "Re:";
}

/**
 * The forward subject for an original's subject — `Fwd: ` exactly once.
 *
 * THE CLIENT OWNS THIS, and that is not an accident of layering: `SendService` builds the outgoing
 * message with `subject: d.subject` — the draft row's subject, verbatim — and adds no prefix of its
 * own. So if this were left out, a forward would go out under the original's bare subject and the
 * recipient would have no way to tell a forward from a fresh message. Everything ELSE about a
 * forward is the server's (the quoted body, the streamed attachments, the `no_forward` refusal);
 * the subject line is the one part the compose form is authoritative for, because it is the one
 * part the user may edit before sending.
 *
 * Same shape as {@link replySubject} and for the same reasons: case-insensitive, so a chain through
 * an Outlook correspondent does not accumulate `Fwd: FW: FWD: …`, and only the LEADING run of
 * prefixes is collapsed. `Fw:` and `Fwd:` are both stripped because both are in wide use, and both
 * normalise to the one form this app writes. A subject that merely contains "fw:" is untouched.
 */
export function forwardSubject(originalSubject: string): string {
  const bare = originalSubject.replace(/^(?:\s*fwd?\s*:\s*)+/i, "").trim();
  return bare ? `Fwd: ${bare}` : "Fwd:";
}

/**
 * THE OPTIMISTIC SENT COPY OF A CONFIRMED SEND — built on `{status:"sent"}`, never before it.
 *
 * A confirmed `mail_send` is the mailbox's own word that the message left and was appended to
 * Sent, minted under `providerMessageId`. This turns that fact into a provisional message row so
 * the reply appears in its conversation in under a second, minutes ahead of the worker's
 * Sent-folder watch ingesting the real one. Unlike `effectsOf`'s `sending` draft this is NOT a
 * mutate-time optimistic effect — the engine calls it from `dispatch` only after the server
 * confirmed — so it never asserts a delivery the server has not owned.
 *
 * The two load-bearing fields:
 *  · `messageIdHeader = providerMessageId` — the exact header the real Sent copy will carry, which
 *    is how the engine reconciles the two and drops this overlay when the drain delivers the row.
 *  · `folder: "Sent"` (cast — Sent is not one of the six `Destination` folders, exactly as the
 *    server files an ingested Sent twin), beside `local: true` marking it provisional.
 *
 * ── WHERE IT SURFACES, CORRECTED ───────────────────────────────────────────────────────────
 *
 * This used to say the copy "matches no pile view and reaches the surface ONLY through its
 * conversation". That was true when it was written and is NOT true now: `ohboxView`'s own-sent
 * union files every mirror row whose folder is not one of the six organised views into "Earlier",
 * and `isOwnSent` is exactly `!OHMAIL_FOLDERS.has(folder)` — which `folder: "Sent"` satisfies. So
 * the copy appears in Earlier as well as in its conversation, from the moment the send confirms
 * until the real row replaces it.
 *
 * That is the right behaviour and it needs no gate: a message the user just sent belongs in their
 * own sent history, `unread: false` keeps it out of "New for you", and the reconcile is by
 * `messageIdHeader`, so the overlay is dropped the instant the ingested row lands — the two are
 * never in the list together. The note is here because the sentence it replaces was load-bearing
 * for anyone reasoning about which surfaces can see a provisional row: the answer is any surface
 * reading the mirror, so `local` is the flag to test, never the folder.
 *
 * Returns `null` when there is nothing to place it against — no mailbox to attribute it to — which
 * is the same refusal `effectsOf`'s `mail_send` makes, so a send that could not resolve a mailbox
 * produces no overlay rather than a headless row.
 */
export function sentOverlayMessage(
  reader: EntityReader,
  m: Extract<EngineMutation, { kind: "mail_send" }>,
  providerMessageId: string,
  ctx: EffectContext,
): EngineMessage | null {
  const parent = m.inReplyTo === null ? null : reader.get<EngineMessage>("message", m.inReplyTo);
  const mailboxId = m.mailboxId ?? parent?.mailboxId;
  if (!mailboxId) return null;

  const iso = ctx.now().toISOString();
  const to = m.to ?? (parent ? [parent.from] : []);
  const subject = m.subject ?? (parent ? replySubject(parent.subject) : "");
  // Parent thread for a reply; a compose starts none — the same rule `effectsOf` follows so a
  // compose never files onto a stranger's conversation in the mirror.
  const threadId = m.threadId ?? parent?.threadId ?? null;
  // The account is single-tenant in a mirror, so any message names it; the parent is the direct
  // source when there is one.
  const accountId = parent?.accountId ?? reader.list<EngineMessage>("message")[0]?.accountId ?? "";

  // OWN FROM — the sender's own identity. The `mailbox` entity carries the address on a Cloud tab
  // whose mailbox poll has landed (`consent-cutline.ts` reads the same list); before that, and on
  // Desktop, it is absent, so this falls back to the address the parent was sent to (the user, on a
  // reply) and finally to a bare empty address. The overlay is transient — the real row replaces it
  // within a drain — so a best-effort From is enough to render "me" until then.
  const mb = reader.list<{ id?: string; address?: string; name?: string }>("mailbox")
    .find((x) => x.id === mailboxId);
  const from: EmailAddress =
    typeof mb?.address === "string" && mb.address.length > 0
      ? { name: mb.name ?? null, address: mb.address }
      : parent?.to?.[0] ?? { name: null, address: "" };

  return {
    id: ctx.uuid(),
    accountId,
    mailboxId,
    threadId,
    messageIdHeader: providerMessageId,
    subject,
    from,
    to,
    cc: m.cc ?? [],
    date: iso,
    // Not a `Destination`; an ingested Sent twin is filed the same way (`materialize.ts` reads the
    // native locator's folder for a row with no folder_state). It matches no view filter.
    folder: "Sent" as Folder,
    snippet: m.body.slice(0, 200),
    body: m.body,
    unread: false,
    hasAttachments: (m.attachments?.length ?? 0) > 0,
    attachmentCount: m.attachments?.length ?? 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    local: true,
    updatedAt: iso,
  } satisfies EngineMessage;
}

/**
 * The ONE source of truth for what each mutation MEANS locally. Both consumers
 * share it, so the optimistic view and the demo "server" can never disagree:
 *
 *  - the Engine turns effects into its optimistic OVERLAY (applied instantly,
 *    user-always-wins, dropped when the authoritative echo lands);
 *  - the FixturesAdapter turns the same effects into authoritative SyncChanges
 *    (it plays the server in ?demo mode and UI tests).
 */

export interface MutationEffect {
  type: string;
  id: string;
  /** The next entity state, or null ⇒ delete/tombstone. */
  entity: unknown | null;
  /** Present when this effect is a message folder transition. */
  move?: { from: Folder | null; to: Folder };
}

export interface EffectContext {
  now: () => Date;
  uuid: () => string;
}

const SEG_FOLDER: Record<string, Folder> = {
  screened: "ohmail/Screened",
  spam: "ohmail/Quarantine",
};

/**
 * WHERE A SCREENER DECISION FILES MAIL — **the one mapping, and there used to be three.**
 *
 * `mutations.ts` had two (this and `destFolderOf`'s fallback chain) and
 * `apps/webapp/app/shell/sender-screening.ts` had a third. While the wire took only
 * `{decision, scope}` they could not disagree about anything that mattered, because two of them
 * were describing a two-valued answer. `dest` now rides `POST /screener/:id` and each of the
 * five buttons files somewhere different, so three copies is three chances for the overlay to
 * paint a folder the server did not write — the delta-first contract's optimistic-parity rule,
 * and the exact shape of the `feed_mark_seen` divergence.
 *
 * The server computes the same answer from the same two fields
 * (`screener-service.ts` — `dest ?? (decision === "yes" ? YES_FOLDER : NO_FOLDER)`), so an
 * overlay built from this function and the row that arrives on the next drain agree.
 */
export function decideFolder(
  m: Pick<Extract<EngineMutation, { kind: "screener_decide" }>, "decision" | "dest">,
): Folder {
  if (m.dest) return FOLDER_OF_VIEW[m.dest];
  return m.decision === "yes" ? "INBOX" : "ohmail/Screened";
}

/**
 * The FIXTURE world's answer, which is {@link decideFolder} plus one thing only the demo has:
 * a stored AI suggestion to fall back on when the press named no destination.
 *
 * `SEG_FOLDER` is consulted first for `screened`/`spam` and is redundant with `FOLDER_OF_VIEW`
 * — kept because the demo's own `ScreenerSenderDTO.ai.dest` vocabulary is not typed to the five
 * views, so an unknown string must still land somewhere sane rather than `undefined`.
 */
function destFolderOf(m: Extract<EngineMutation, { kind: "screener_decide" }>, sender: ScreenerSenderDTO): Folder {
  if (m.dest) return decideFolder(m);
  if (m.decision === "no") return "ohmail/Screened";
  const dest = sender.ai?.dest ?? "ohbox";
  return SEG_FOLDER[dest] ?? FOLDER_OF_VIEW[dest as keyof typeof FOLDER_OF_VIEW] ?? "INBOX";
}

function promotedRule(
  from: EmailAddress,
  scope: "sender" | "domain",
  destination: Folder,
  ctx: EffectContext,
): RuleDTO {
  const iso = ctx.now().toISOString();
  return {
    id: ctx.uuid(),
    kind: scope,
    match: scope === "domain" ? from.address.split("@")[1] ?? from.address : from.address,
    destination,
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * A DERIVED sender's decision: `m.senderId` is the REPRESENTATIVE MESSAGE id,
 * so the effect is per-message moves across everything that sender is holding, plus the
 * promoted rule the server will also create.
 *
 * The Screener-folder precondition is not a nicety: the server resolves `:id` against
 * rows whose DESIRED FOLDER is `ohmail/Screener` only (`screener-service.ts:257`), so a
 * representative outside that folder is a 404 on the wire. Producing no effect makes the
 * engine reject it locally with the same verdict instead of moving mail optimistically
 * and rolling it back a round-trip later.
 */
function derivedScreenerEffects(
  reader: EntityReader,
  m: Extract<EngineMutation, { kind: "screener_decide" }>,
  ctx: EffectContext,
  iso: string,
): MutationEffect[] {
  const rep = reader.get<EngineMessage>("message", m.senderId);
  if (!rep || rep.folder !== FOLDER_OF_VIEW.screener) return [];

  const key = senderKey(rep.from.address);
  // The folder the SERVER will write, computed from the same two fields it reads. `m.dest` is
  // honoured now — it is on the wire. While it was not, this had to ignore it and the surface
  // composed a follow-up `move`, which is the composition that lost a race against the decide's
  // own `folder_state` write and filed bulk mail to the Ohbox for senders admitted to Reads.
  const destination = decideFolder(m);
  const effects: MutationEffect[] = reader
    .list<EngineMessage>("message")
    .filter((x) => x.folder === FOLDER_OF_VIEW.screener && senderKey(x.from.address) === key)
    .map((msg) => ({
      type: "message",
      id: msg.id,
      // NO `unread` FLIP. "&read" is STILL not a field on `POST /screener/:id`, so the seen
      // half of a "file & read" remains a separate `mark_seen` the surface dispatches — the
      // two halves of THIS mutation say exactly what the wire says.
      entity: { ...msg, folder: destination, updatedAt: iso } satisfies EngineMessage,
      move: { from: msg.folder, to: destination },
    }));

  const rule = promotedRule(rep.from, m.scope ?? "sender", destination, ctx);
  effects.push({ type: "rule", id: rule.id, entity: rule });
  return effects;
}

/**
 * Compute the entity-level effects of a mutation against the current local
 * state. Unknown targets yield [] — the caller decides whether that is a no-op
 * or a rejection.
 */
export function mutationEffects(reader: EntityReader, m: EngineMutation, ctx: EffectContext): MutationEffect[] {
  const iso = ctx.now().toISOString();

  switch (m.kind) {
    case "move": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg || msg.folder === m.folder) return [];
      return [{
        type: "message",
        id: msg.id,
        entity: { ...msg, folder: m.folder, updatedAt: iso } satisfies EngineMessage,
        move: { from: msg.folder, to: m.folder },
      }];
    }

    case "triage_set": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg) return [];
      if (m.state === "none") {
        return [
          { type: "message_state", id: m.messageId, entity: null },
          { type: "message", id: msg.id, entity: { ...msg, triage: null, updatedAt: iso } },
        ];
      }
      const state: MessageStateDTO = {
        messageId: m.messageId,
        state: m.state,
        // The wire keeps `bubbleUpAt` for exactly one state, so the overlay must too — the
        // server drops it on every other state, and an overlay showing a date the next delta
        // then removes would be the two halves of one mutation disagreeing.
        bubbleUpAt: m.state === "bubbled_up" ? m.bubbleUpAt ?? null : null,
        setAt: iso,
        updatedAt: iso,
      };
      return [
        { type: "message_state", id: m.messageId, entity: state },
        { type: "message", id: msg.id, entity: { ...msg, triage: state, updatedAt: iso } },
      ];
    }

    case "screener_decide": {
      // A fixture row wins, exactly as it does in `screenerSegments()`. With none, the
      // sender is DERIVED from the message mirror and `m.senderId` is a message id.
      const sender = reader.get<ScreenerSenderDTO>("screener_sender", m.senderId);
      if (!sender) return derivedScreenerEffects(reader, m, ctx, iso);
      const scope = m.scope ?? sender.scope ?? "sender";
      const destination = destFolderOf(m, sender);
      const effects: MutationEffect[] = [];

      if (m.decision === "yes") {
        // Yes → the sender's held mail is filed into the destination; "&read"
        // seen-semantics: the held mail lands already-seen (previously_seen,
        // not new_for_you). The waiting entry disappears; a promoted rule
        // remembers the decision.
        sender.held.forEach((held, i) => {
          const msg: EngineMessage = {
            id: ctx.uuid(),
            accountId: "demo",
            mailboxId: "lichtgrat",
            threadId: null,
            messageIdHeader: null,
            subject: held.subject,
            from: sender.from,
            to: [],
            cc: [],
            date: new Date(ctx.now().getTime() - i * 60_000).toISOString(),
            folder: destination,
            snippet: held.body.split("\n")[0] ?? "",
            unread: !m.read,
            hasAttachments: false,
            attachmentCount: 0,
            sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
            triage: null,
            labels: [],
            remoteContent: held.trackerNote ? "blocked" : "none",
            updatedAt: iso,
            body: held.body,
            time: held.time,
            ...(held.trackerNote ? { trackerNote: held.trackerNote } : {}),
          };
          effects.push({ type: "message", id: msg.id, entity: msg });
        });
        effects.push({ type: "screener_sender", id: sender.id, entity: null });
      } else {
        // No → the sender moves to the screened-out ledger (reversible; the
        // fixture world keeps the entry, segment-flipped). The whole held bag
        // travels with it — screening out holds mail, it never discards it.
        effects.push({
          type: "screener_sender",
          id: sender.id,
          entity: {
            ...sender,
            segment: "screened_out",
            screenedOn: iso.slice(0, 10),
            updatedAt: iso,
          } satisfies ScreenerSenderDTO,
        });
      }
      const rule = promotedRule(sender.from, scope, destination, ctx);
      effects.push({ type: "rule", id: rule.id, entity: rule });
      return effects;
    }

    case "tag_assign": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg) return [];
      const labels = m.labels ?? (
        m.assigned
          ? [...new Set([...msg.labels, m.tagId])]
          : msg.labels.filter((l) => l !== m.tagId)
      );
      return [{ type: "message", id: msg.id, entity: { ...msg, labels, updatedAt: iso } }];
    }

    /**
     * A tag row and nothing else. An empty name yields no effects: the server answers 400,
     * and a nameless tag is not a thing any list can render.
     *
     * `hue` defaults to `moss` here and is NOT sent unless the caller chose one — the server
     * defaults to the same value, so the optimistic row and the echo agree without the client
     * asserting a colour it did not pick.
     */
    case "tag_create": {
      const name = m.name.trim();
      if (name === "") return [];
      const tag: TagDTO = {
        id: m.tagId,
        name,
        hue: m.hue ?? "moss",
        createdAt: iso,
        updatedAt: iso,
      };
      return [{ type: "tag", id: tag.id, entity: tag }];
    }

    /**
     * The rename, on the row the mirror already holds. Unknown id yields [] — the engine
     * reports that as a rejection, which is right: the tag was deleted under the cursor.
     */
    case "tag_rename": {
      const tag = reader.get<TagDTO>("tag", m.tagId);
      const name = m.name.trim();
      if (!tag || name === "") return [];
      return [{ type: "tag", id: tag.id, entity: { ...tag, name, updatedAt: iso } satisfies TagDTO }];
    }

    /**
     * The recolour, on the row the mirror already holds — the {@link tag_rename} shape, one
     * field over. Unknown id yields [] (rejected: the tag was deleted under the cursor); an
     * empty hue yields [] (the server would 400 it, and a hue is never blank from a picker).
     */
    case "tag_recolor": {
      const tag = reader.get<TagDTO>("tag", m.tagId);
      const hue = m.hue.trim();
      if (!tag || hue === "") return [];
      return [{ type: "tag", id: tag.id, entity: { ...tag, hue, updatedAt: iso } satisfies TagDTO }];
    }

    /**
     * THE TOMBSTONE **AND** EVERY MESSAGE THAT CARRIED IT.
     *
     * `TagsService.remove` deletes the `message_tags` rows in the same transaction and emits
     * one `message` change per affected message. Mirroring only the tag would leave the id in
     * each message's `labels` until the next drain — and `tagsOfMessage` filters ids the
     * mirror does not know, so the chip would vanish anyway while `labels` stayed wrong. Two
     * representations of one fact, disagreeing for as long as the drain takes.
     */
    case "tag_delete": {
      const tag = reader.get<TagDTO>("tag", m.tagId);
      if (!tag) return [];
      const effects: MutationEffect[] = reader
        .list<EngineMessage>("message")
        .filter((msg) => msg.labels.includes(m.tagId))
        .map((msg) => ({
          type: "message" as const,
          id: msg.id,
          entity: { ...msg, labels: msg.labels.filter((l) => l !== m.tagId), updatedAt: iso },
        }));
      effects.push({ type: "tag", id: tag.id, entity: null });
      return effects;
    }

    case "feed_mark_seen": {
      const feed = reader
        .list<EngineMessage>("message")
        .filter((msg) => msg.folder === "ohmail/Reads");
      const targets = m.messageIds
        ? feed.filter((msg) => m.messageIds!.includes(msg.id))
        : feed.filter((msg) => msg.unread);
      // `lastReadAt` beside `unread`, exactly as the server writes it. The overlay is not
      // decoration here: the Ohbox sorts its read group by this field, so an optimistic flip that
      // left it alone would move the row into "Earlier" at the BOTTOM of the list and then jump it
      // to the top when the server's answer landed. One visible reorder per read, from the client
      // and the server disagreeing about a field only one of them was writing.
      const effects: MutationEffect[] = targets.map((msg) => ({
        type: "message",
        id: msg.id,
        entity: { ...msg, unread: false, lastReadAt: iso, updatedAt: iso },
      }));
      const newest = [...feed].sort((a, b) => Date.parse(b.date ?? "0") - Date.parse(a.date ?? "0"))[0];
      const afterId = m.upToId ?? newest?.id;
      if (afterId) {
        const now = ctx.now();
        const hh = String(now.getUTCHours()).padStart(2, "0");
        const mm = String(now.getUTCMinutes()).padStart(2, "0");
        effects.push({
          type: "view_meta",
          id: "reads_waterline",
          entity: { afterId, label: "Seen up to here", meta: `last visit · ${hh}:${mm}` } satisfies WaterlineMeta,
        });
      }
      return effects;
    }

    case "mark_seen": {
      // NO FOLDER FILTER, and that is the entire difference from `feed_mark_seen` above. The
      // wire side PATCHes exactly `m.messageIds`; this flips exactly `m.messageIds`. Any
      // predicate here that the wire does not also apply is a divergence between the optimistic
      // view and the server — which is the bug that made `feed_mark_seen` unusable outside
      // Reads, and it is the reason this branch looks boringly literal.
      //
      // An id the mirror does not know is dropped (there is no entity to produce), so a
      // selection of entirely unknown ids yields [] and the engine reports it as a rejection
      // rather than pretending to have applied something.
      //
      // `lastReadAt` travels with the flag in BOTH directions, and the second one is the half
      // worth stating: marking unread clears it, because a message the user deliberately put back
      // has no reading to be ordered by. Keeping the old instant would leave it stamped as
      // recently finished with, and it would file itself at the top of "Earlier" the moment
      // anything marked it read again. The server's own writer does exactly this, so the overlay
      // and the answer that replaces it agree.
      const effects: MutationEffect[] = [];
      for (const id of m.messageIds) {
        const msg = reader.get<EngineMessage>("message", id);
        if (!msg) continue;
        effects.push({
          type: "message",
          id,
          entity: { ...msg, unread: m.unread, lastReadAt: m.unread ? null : iso, updatedAt: iso },
        });
      }
      return effects;
    }

    case "mail_send": {
      // ── A REPLY: the parent IS the mutation ───────────────────────────────────────────
      //
      // It supplies the recipient, the mailbox and the thread. An id the mirror does not know
      // yields [], which the engine reports as a rejection — better than composing a reply to
      // nobody and discovering it on the wire.
      const parent = m.inReplyTo === null ? null : reader.get<EngineMessage>("message", m.inReplyTo);
      if (m.inReplyTo !== null && !parent) return [];

      // ── A COMPOSE: the two things it cannot be sent without ───────────────────────────
      //
      // `to` empty is refused HERE and not left to the server, which answers 400 "draft has
      // no recipients" only AFTER `POST /drafts` has already written a row — an orphan draft
      // per press. `mailboxId` empty means the mirror could not name a mailbox to send from
      // (`sendingMailboxId`), and the server would 400 that too. Both yield [] ⇒ the engine
      // rejects locally with nothing on the wire.
      const mailboxId = m.mailboxId ?? parent?.mailboxId;
      if (!mailboxId) return [];
      const to = m.to ?? (parent ? [parent.from] : []);
      if (to.length === 0) return [];

      // ONE `draft` row at `sending`, complete in every field of `EngineDraft` so any future
      // consumer that lists drafts gets a whole entity rather than a half one. It carries a
      // CLIENT uuid; the server's row arrives under its own id on the next drain, and this
      // overlay is dropped the moment the mutation resolves, so the two never coexist.
      //
      // NOTE for the demo world: `FixturesAdapter` replays this same effect AUTHORITATIVELY,
      // so a demo send leaves a draft parked at `sending` forever. Harmless while nothing
      // renders drafts; revisit if an Outbox ever does.
      const draft: EngineDraft = {
        id: ctx.uuid(),
        mailboxId,
        // NO PARENT ⇒ NO THREAD, and `?? null` rather than `?? parent?.threadId` would have
        // been the same thing written less plainly. A compose that inherited a thread id
        // would file a stranger's mail onto an existing conversation in our own mirror even
        // though the outgoing headers were clean.
        threadId: m.threadId ?? parent?.threadId ?? null,
        inReplyToMessageId: parent?.id ?? null,
        subject: m.subject ?? (parent ? replySubject(parent.subject) : ""),
        body: m.body,
        to,
        // Compose fills these; a reply leaves them unset. The overlay carries what the wire
        // carries, so a listed draft shows the same recipients the server will deliver to.
        cc: m.cc ?? [],
        bcc: m.bcc ?? [],
        rationale: null,
        status: "sending",
        createdAt: iso,
        updatedAt: iso,
      };
      return [{ type: "draft", id: draft.id, entity: draft }];
    }

    /**
     * ── AUTOSAVE ─────────────────────────────────────────────────────────────────────────
     *
     * CREATE (`draftId: null`) mints a client-local id for the overlay, exactly as `rule_create`
     * and `tag_create` do and for the same reason: the server's row does not exist yet, the
     * overlay is dropped the moment the mutation confirms, and the server's own row arrives in
     * the echo — so the two ids never coexist. What is different here is that the caller then
     * ADOPTS the server's id (`MutationResult.entityId`), because the next autosave has to reach
     * the same row.
     *
     * UPDATE patches the row already in the mirror. An unknown id yields [] ⇒ the engine rejects
     * locally with `not_found` and nothing goes on the wire, which is right for a draft another
     * device deleted while this tab was typing.
     *
     * `status` is never written here: a draft is created at `draft` and only the send route may
     * move it. `mailboxId` is required for the create and refused when absent — the server would
     * 400 it, and a row written without one cannot be sent from anywhere.
     */
    case "draft_save": {
      if (m.draftId === null) {
        if (!m.mailboxId) return [];
        const draft: EngineDraft = {
          id: ctx.uuid(),
          mailboxId: m.mailboxId,
          threadId: m.threadId ?? null,
          inReplyToMessageId: m.inReplyToMessageId ?? null,
          subject: m.subject,
          body: m.body,
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
          rationale: null,
          status: "draft",
          createdAt: iso,
          updatedAt: iso,
        };
        return [{ type: "draft", id: draft.id, entity: draft }];
      }
      const existing = reader.get<EngineDraft>("draft", m.draftId);
      if (!existing) return [];
      return [{
        type: "draft",
        id: existing.id,
        entity: {
          ...existing,
          // The FIELDS the form owns, and nothing else. `status`, `mailboxId`, `threadId` and
          // `inReplyToMessageId` are settled at create and are not the form's to move: changing
          // the mailbox of a draft mid-write would change which address it goes out from without
          // saying so, and the server refuses it anyway (the column is immutable after create).
          subject: m.subject,
          body: m.body,
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
          updatedAt: iso,
        } satisfies EngineDraft,
      }];
    }

    case "draft_discard": {
      const draft = reader.get<EngineDraft>("draft", m.draftId);
      if (!draft) return [];
      return [{ type: "draft", id: draft.id, entity: null }];
    }

    case "draft_accept": {
      const draft = reader.get<EngineDraft>("draft", m.draftId);
      if (!draft) return [];
      return [{ type: "draft", id: draft.id, entity: { ...draft, accepted: true, updatedAt: iso } }];
    }

    /**
     * REVOKE — a tombstone, and NOTHING ELSE.
     *
     * The absent effects are the specification. `screener_decide` produces one rule effect
     * AND a `move` per held message, because deciding at the gate genuinely re-files mail.
     * Revoking does not: `RulesService.remove` deletes the row and appends a `rule` delete,
     * and never reads `folder_state`. If this branch also emitted moves, the optimistic view
     * would re-sort a backlog the server is not going to touch, and the next drain would
     * silently put it all back — the user watching a thousand rows move and then un-move.
     *
     * An unknown id yields [] ⇒ the engine rejects locally with `not_found` and nothing goes
     * on the wire, which is the right answer for a rule a concurrent drain already removed.
     */
    case "rule_delete": {
      const rule = reader.get<RuleDTO>("rule", m.ruleId);
      if (!rule) return [];
      return [{ type: "rule", id: rule.id, entity: null }];
    }

    /**
     * Same rule about mail, same reason: `PATCH /rules/:id` writes the `rules` row and the
     * change log, and the routing pass consults rules when mail ARRIVES. Nothing already
     * filed moves, so nothing here produces a `message` effect.
     *
     * A no-op patch (the destination it already has) still yields an effect rather than [],
     * because [] is the engine's "target not found" signal and reporting a rejection for a
     * request the server would happily accept is the wrong error. The surface does not offer
     * the current destination as a choice anyway.
     */
    case "rule_update": {
      const rule = reader.get<RuleDTO>("rule", m.ruleId);
      if (!rule) return [];
      return [{
        type: "rule",
        id: rule.id,
        entity: { ...rule, destination: m.destination, updatedAt: iso } satisfies RuleDTO,
      }];
    }

    /**
     * ONE `rule` ROW, AND NO `message` EFFECT.
     *
     * The absent effects are the specification, exactly as they are for `rule_delete`. A rule is
     * consulted when mail ARRIVES; nothing already filed moves because a rule was written. The
     * surface that dispatches this composes its own `move`s for the mail it can see, from the
     * same scope, so the mail that relocates and the rule that is written can never disagree
     * about whose mail this is — which is the shape of the defect already fixed in `decide`.
     *
     * `provenance: "manual"` is not a guess: `RulesService.create` inserts exactly that, and an
     * optimistic row claiming `promoted` would flip to "you made this one" under the user's eyes
     * on the echo. `priority` is fabricated as 0 and is NOT sent — `validPriority(undefined)`
     * answers 0 — so the two agree without the client asserting a ranking it did not choose.
     *
     * The id is a CLIENT uuid and the server's row arrives under its own, the same trade
     * `screener_decide`'s promoted rule already makes. The overlay is dropped the moment the
     * mutation resolves and the echo carries the real row, so the two never coexist for longer
     * than one render.
     *
     * An empty `match` yields [] ⇒ the engine rejects locally with nothing on the wire, which is
     * the right answer for a request the server would answer 400. It is unreachable from the
     * sheet (a domain-less address is never offered domain scope) and is here so that it stays
     * unreachable rather than becoming a rule matching every malformed sender.
     *
     * TWO MORE REFUSALS, both by the same mechanism and both about `subjectContains`:
     *
     *  · a term on a NON-`sender` kind — `RulesService.validSubjectContains` answers 400, so the
     *    honest local answer is a rejection with nothing sent;
     *  · a term that is a STRING but trims to nothing. `""` is a substring of every subject, so
     *    storing one literally is a rule that matches everything while its row reads as specific,
     *    and the server refuses it for that reason. Dropping the field and creating a BARE rule
     *    instead would be the silent widening the service's own note refuses: the surface asked for
     *    "just the ones whose subject matches" and the mirror would show a rule covering all of the
     *    sender's mail — an optimistic row that is a different rule from the one requested. An
     *    explicit `null`/`undefined` still means "no term" and creates the ordinary bare rule.
     *
     * All three refusals are unreachable from the surfaces — the subject sheet is always about one
     * message's sender and normalizes its term — and all three are written so that they STAY
     * unreachable rather than becoming a rule that quietly means something else.
     *
     * `bodyContains` (mail 0052) gets the same two term refusals by the same mechanism, for the
     * same reasons: a blank body term is a rule matching every message, and a term on a non-sender
     * kind is a request the server answers 400.
     */
    case "rule_create": {
      if (m.match === "") return [];
      const raw = m.subjectContains;
      const term = typeof raw === "string" ? raw.trim() : "";
      if (typeof raw === "string" && term === "") return [];
      if (term !== "" && m.ruleKind !== "sender") return [];
      // The body term (mail 0052): the same two refusals by the same mechanism, so a blank or
      // mis-kinded third term is rejected locally with nothing on the wire rather than becoming
      // an optimistic row for a rule the server will refuse — or worse, a silently-broadened one.
      const rawBody = m.bodyContains;
      const bodyTerm = typeof rawBody === "string" ? rawBody.trim() : "";
      if (typeof rawBody === "string" && bodyTerm === "") return [];
      if (bodyTerm !== "" && m.ruleKind !== "sender") return [];
      const rule: RuleDTO = {
        id: ctx.uuid(),
        kind: m.ruleKind,
        match: m.match,
        destination: m.destination,
        priority: 0,
        provenance: "manual",
        enabled: true,
        // TRIMMED, and `""` collapses to `null` — the same normalisation
        // `RulesService.validSubjectContains` applies, so the optimistic row and the echoed row
        // carry the same string rather than one with the user's trailing space and one without.
        subjectContains: term === "" ? null : term,
        // `validBodyContains`' normalisation, for the same one-string-both-rows reason.
        bodyContains: bodyTerm === "" ? null : bodyTerm,
        stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: iso,
        updatedAt: iso,
      };
      return [{ type: "rule", id: rule.id, entity: rule }];
    }
  }
}
