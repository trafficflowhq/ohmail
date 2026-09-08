"use client";

/**
 * THE SEND LOCK, WHERE A LOCK BELONGS: ON DISK, NOT IN A REF.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────
 *
 * `useMailSend` holds `queued`, `inFlight` and `locked` in `useRef`,
 * and the file's own comment explains why `locked` had to move OUT of React state: two calls in one
 * tick each read `idle`, each minted an Idempotency-Key, and each delivered — two reservations, two
 * deliveries, to a real person. That argument is correct and it does not go far enough. **A ref
 * dies with its component.** A reload inside the queued window leaves the durable outbox to replay
 * the send under its original key (correct) while the restored composer — the scratch draft is in
 * `localStorage` and is only cleared when the UI observes a confirmation — comes up `idle`, and the
 * next press mints a SECOND key. A second key is a different key, so `idempotency_keys` cannot
 * replay it and `outbound_sends UNIQUE (account_id, idempotency_key)` cannot collapse it: the same
 * message is delivered twice to an external recipient, which is a thing this product cannot take
 * back. One press is one delivery, across a crash, is the guarantee the send path owes; nothing
 * else in this application has an outcome that cannot be rolled back.
 *
 * ── THE FIX: THE DURABLE KEY *IS* THE LOCK ──────────────────────────────────────────────────
 *
 * The Idempotency-Key is persisted with the send LANE at the moment it is minted — synchronously,
 * before the verb reaches the engine — and a press on a lane that already holds one RESUMES that
 * key instead of minting a fresh one (`OhmailEngine.mutate(m, { key })`). From there the server is
 * the authority, and it already has the right answer: `SendService.resumeExisting` replays a `sent`
 * row's stored result without re-sending, reports a `failed` one, answers `in_flight` while the
 * first attempt may still be running, and verify-by-Sent recovers a genuinely orphaned `pending`.
 * **The one thing it never does is send again.**
 *
 * So the in-memory `locked` ref stays and becomes ADVISORY: it is the only check that is correct
 * within a single tick, which is the race it was written for. This is the one that is correct
 * across a process, which is the race it was not.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────
 *
 * It is not a queue and it is not a retry record — the durable outbox is both of those and owns
 * the verb from the moment `mutate` is called. This holds one fact per SEND: *the key that send is
 * going out under*, with the subject and the fingerprint that say which message it was.
 *
 * A lane therefore holds at most one ordinary claim and every UNRESOLVED record it has collected.
 * That is a change from the one-per-lane rule this paragraph used to state, and the reason is that
 * the two kinds of record have different lifetimes: an ordinary claim is spent by the next press,
 * while an unresolved one is the only evidence a message may already be out there and must outlive
 * every press after it. `confirmed` and `failed` release the record for the message they settle —
 * resuming a spent key would replay the old outcome for ever, a wedged Send button rather than a
 * duplicate mail, but still wrong. `unverified` does NOT release: nobody knows what it did.
 *
 * Owner-keyed, wrapped, `"local"`-defaulted: the same three rules `composeDraftKey` states one file
 * over, for the same reasons. A blocked jar means the lock is only as durable as the tab, which is
 * exactly where this file found it.
 *
 * ══ INVARIANT S — THE ONE RULE THE SEND SEAM OBEYS ═══════════════════════════════════════════
 *
 * Written here, once, because it was NOT written anywhere before and seven consecutive fixes each
 * closed one duplicate route while the next was found: the question "is this message held?" was
 * asked in three places with three answers, and every fix moved WHO the message is rather than
 * WHERE the question is asked.
 *
 * > **S.** A message-in-progress *M* is named by its compose session while unsaved and by its row
 * > id once saved; the durable record carries every name *M* has acquired. At every instant:
 * > **(1)** the account holds at most one `drafts` row whose content is *M*; **(2)** a row past
 * > `draft` (`sending`, `unverified`, `sent`) or one that carries a send record is never PUT to,
 * > never DELETEd by this client, and never recovered into a fresh key; **(3)** a send of *M* that
 * > is not confirmed — `unverified`, transport-`queued`, server-`queued` — is PARKED under *M*'s
 * > names: a press resumes the same Idempotency-Key or is refused, and unchanged content never
 * > mints a second key while a record exists; **(4)** the hold is answered by ONE predicate, and a
 * > jar that cannot be read answers *unknown*, on which every write site fails closed; an EMPTY
 * > jar admits.
 *
 * ══ INVARIANT T — WHAT HAPPENS WHEN M'S FATE BECOMES KNOWN ═════════════════════════════════
 *
 * S says which message a compose is holding. T says what happens when that message's story ends,
 * and it is written here because three separate sequences ended the same way: the fate arrived,
 * the RECORD was tidied up, and the compose was left POPULATED with the delivered text behind a
 * projection reading `idle` — so the next ordinary press or pause treated it as a new message.
 * One of those was a second delivery.
 *
 * > **T.** A compose is BOUND to at most one message *M* (its row id and/or its compose session).
 * > When *M*'s fate resolves — the mirror shows *M*'s row `sent`; the server answers 409
 * > `send_recorded` to a discard of *M*; the durable outbox settles a `mail_send` for the
 * > compose's lane — the bound compose either **(a) ADOPTS** the resolving row, or **(b) CLEARS**
 * > exactly as the live confirmed path clears. It never remains populated with *M*'s text behind a
 * > projection that would admit a fresh key.
 *
 * The resolution is answered by ONE function, `settleCompose(fate)` in `compose-autosave.ts` — the
 * hook owns the binding, so it owns its ending — and every site that releases, adopts or clears a
 * compose ON A FATE goes through it. A door that merely REPLACES the message on screen (the
 * reopen, Write-to, a mail link) is an identity move and not a fate; those keep their own release.
 * The census pins both lists.
 *
 * The one predicate is {@link holdOf}. Every write site consults it — the autosave create, the
 * autosave PUT, the adopt-on-mount, `openDraft`, `writeTo`, the mailto seam, `cancelCompose`, the
 * Send press, the settled discard — and a census in the web application's own suite pins the
 * per-file CALL-SITE COUNT so a new write site has to name itself there. A route a reviewer finds
 * that the census admits is a MISSING CALL SITE, fixed by adding the call, never by a second
 * predicate.
 *
 * TWO DECISIONS THAT LIVE IN THE INVARIANT AND NOT IN A CALLER:
 *
 *  1. **A record resumes across sessions only when it is unresolved.** `r.session === id.session`
 *     OR `r.unverified === true`. An ordinary claim belongs to the message-in-progress it was
 *     pressed in and a different session is a different message; an unresolved record is the only
 *     evidence a message may already be out there, and refusing to resume it is exactly how the
 *     next press mints a fresh key for mail that has already gone.
 *  2. **`unknown` admits the PRESS and refuses every RECOVERY.** A browser that will not let this
 *     app read its own storage must still be able to send — refusing there would leave somebody
 *     with a message the product declines to send and cannot explain. But it must not DISCARD a
 *     row, re-mint a key, or adopt a row into a fresh session on evidence it does not have.
 */

import type { MailSend } from "./compose";
import { storageOwner } from "./storage-owner";

/**
 * THE RECORD SHAPE THIS BUILD WRITES.
 *
 * `1` was written by every build up to and including 0.14.0 and was NOT bumped when 0.14.1
 * changed what a fingerprint hashes — which is the whole reason the legacy path below cannot key
 * off it and reads the record's SHAPE instead. `2` is this build's, and it is bumped here so the
 * next change to either the fingerprint or the field set has a number to move.
 *
 * Higher values are records from a build this one has never seen. They are carried and never
 * touched: not matched, not rewritten, not deleted. A rolled-back install must not eat the
 * evidence that a newer one left behind.
 */
export const SEND_LOCK_FORMAT = 3;

/**
 * THE LAST FORMAT WHOSE RECORDS THE 0.14.0 DECODE MAY FIRE ON — a literal, not `SEND_LOCK_FORMAT - 1`.
 *
 * {@link mayMatchLegacy} used to read `r.v < SEND_LOCK_FORMAT`, which was correct while that
 * constant was `2` and silently wrong the moment it moved: a `3` would have made every RELEASED
 * 0.14.1 record (`v: 2`) "a 0.14.0 record", rewritten it as nameless and unverified, and thrown
 * away the subject and session that are the only things naming the message it belongs to. The
 * predicate is about ONE released shape, so it names that shape's number.
 */
const LAST_0_14_0_FORMAT = 1;

/**
 * THE LAST FORMAT WHOSE FINGERPRINT IS IN THE 0.14.1 ALGEBRA — the other half of the same idea.
 *
 * The released 0.14.1 build wrote `v: 2` and hashed the draft row into the fingerprint. This build
 * writes `v: 3` and does not. A record at or below this number is compared against
 * {@link legacySendFingerprint_0_14_1}; anything above it against {@link sendFingerprint}.
 */
const LAST_0_14_1_FORMAT = 2;

/** One lane's unsettled send. `v` names the shape; an unrecognised record is carried, not guessed. */
export interface SendLock {
  /** {@link SEND_LOCK_FORMAT} at the moment it was written. */
  v: number;
  /** The lane, as `sendKeyOf` derives it: `"compose"`, `"fwd:<id>"`, or a parent message id. */
  lane: string;
  /** The Idempotency-Key this lane's send is going out under. */
  key: string;
  /** Epoch ms at the mint. */
  at: number;
  /** The draft row the send names, when it has one — diagnostic, never used to choose a key. */
  draftId: string | null;
  /**
   * WHICH MESSAGE THIS SEND IS OF — {@link sendSubject}. Absent on a record written before the
   * subject existed; such a record parks nothing by subject and is read by fingerprint alone,
   * which is what it was written under.
   */
  subject?: string;
  /**
   * THE COMPOSE SESSION THIS SEND WAS PRESSED IN, when the lane has one — the SECOND identity,
   * and the reason it exists is a measured double delivery.
   *
   * `subject` alone is not stable across the life of one message. A compose with no draft row
   * yet is named `compose:<session>`; the moment autosave gives it a row the same
   * message-in-progress is named `draft:<id>`, because {@link sendSubject} prefers the row. So an
   * unresolved send recorded before the row existed parked NOTHING once the row appeared: the
   * surface presented `idle`, Send lit up, and a press with nothing edited minted a second key
   * and delivered the message a second time. The recipient held two copies and the sender's Sent
   * folder held one, so neither side showed the duplicate.
   *
   * The session id is minted beside the scratch draft and cleared with it (`composeSessionId`),
   * so it names the message-in-progress for exactly as long as that message exists — across the
   * row appearing, across a reload, across the row being REPLACED. Recorded here in addition to
   * `subject` rather than instead of it, because neither identity is available in every path:
   * a draft reopened after the session was cleared has only `draft:<id>`, and a compose that
   * never autosaved has only `compose:<session>`. {@link sendSubjects} reads both and a record
   * parks a message when the two sets INTERSECT.
   *
   * Absent on a record written by a build before this field, and on every lane that is not the
   * compose surface (a reply and a forward are named by the message they answer, which no
   * autosave can change).
   */
  session?: string;
  /** {@link sendFingerprint} of the message this key was minted for. */
  fp: string;
  /**
   * TRUE once this lane's send came back UNVERIFIED — issued, answer lost, nobody knows.
   *
   * It changes what the record means. An ordinary lock is a convenience: it lets a resumed press
   * reuse a key instead of minting one. An unverified lock is the ONLY durable evidence that a
   * message may already be out there, so it outlives both of the things that discard an ordinary
   * one — the age limit, and a change of content — because discarding it is precisely how the
   * next press comes to mint a fresh key for a message that has already gone.
   */
  unverified?: boolean;
}

/**
 * FNV-1a, 32-bit, unsigned, base36 — short enough to read in a jar dump and stable across builds.
 *
 * Shared by the envelope and by each attachment's content rather than written twice, because the
 * two copies would be two chances for them to drift into different hashes of the same bytes.
 */
function fnv1a(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * WHICH MESSAGE THIS KEY BELONGS TO — the guard that stops a resumed key from swallowing a
 * DIFFERENT message, which is the worse defect a naive durable lock would introduce.
 *
 * Consider the lane alone as the identity. A compose that never autosaved has `draftId: null`,
 * so the lane `"compose"` plus a null draft id is the identity of *every* compose this browser
 * will ever write. Crash between the mint and the terminal outcome, write a NEW message, press
 * Send: the stored key is resumed, the server finds that key already reserved and replays the
 * FIRST send's stored result, the editor reads `confirmed`, clears the scratch and says "Sent."
 * — and the new message was never sent at all. A silently unsent mail is strictly worse than the
 * duplicate this file exists to prevent, so the lock is bound to the message and not just to the
 * surface.
 *
 * A cheap non-cryptographic hash (FNV-1a) over the envelope the user actually composed. It is not
 * a security control and nothing branches on a collision being impossible: a collision would mean
 * two different messages that agree on every recipient, the subject, the body, the parent and the
 * schedule, which is a message being sent twice on purpose. What it has to do is CHANGE when the
 * user changes what they wrote, and it does.
 *
 * ── THE ATTACHMENTS ARE FOLDED IN BY CONTENT, AND THE ARGUMENT FOR LENGTH WAS WRONG ─────────
 *
 * This hashed each attachment's name, type and byte LENGTH, on the reasoning that content hashing
 * was "a cost with no case behind it" because "you cannot alter a picked file in place". The
 * premise is false in this codebase. `ComposeAttach` re-encodes a picked picture in place under
 * its ORIGINAL filename when the quality control moves, and a regenerated document keeps its
 * name — so two different files of the same length under one name were one message. Two sends
 * then shared an Idempotency-Key, and because the server never sends twice under a key it has
 * reserved, the second one had the first's stored result replayed at it: the editor said "Sent."
 * about a file that never left. A silently unsent mail is the worse half of the pair this file
 * exists to prevent, so the content is hashed.
 *
 * The cost is one pass over the base64 per press, bounded by the surface's own cap — 3 MB, or
 * 40 MB for a client permitted to stage. Both the length AND the content hash are folded in, so a
 * collision needs agreement on both.
 */
export function sendFingerprint(m: MailSend): string {
  /**
   * THE DISPLAY NAME IS PART OF THE RECIPIENT, because it is part of what goes out.
   *
   * This read the address alone. The adapter puts the whole `EmailAddress` on the wire — `PUT
   * /drafts/:id` and `POST /drafts` both send `to: m.to ?? []` — and the name is what the
   * recipient's client shows, so a message whose only correction was the name it addresses
   * somebody by hashed as the uncorrected one and could be handed its key.
   *
   * `JSON.stringify` over a pair per recipient rather than a delimiter join: a name is free text
   * and may contain whatever the join used, which would let two different lists agree on one
   * string. An absent name and a `null` one collapse to the same value on purpose — both record
   * "no display name", which is the fact the wire carries either way.
   *
   * The address keeps its lowercasing: a mailbox is not case-sensitive to the sender's typing,
   * and a re-send of the same message with the address retyped in another case is the same
   * message, which is exactly the press that must resume its key.
   */
  const addrs = (xs: ReadonlyArray<{ name?: string | null; address: string }> | undefined): string =>
    JSON.stringify((xs ?? []).map((a) => [a.name ?? null, a.address.toLowerCase()]));
  /**
   * ── EVERY FIELD THE WIRE CARRIES, AND THE TWO THAT WERE MISSING ─────────────────────────────
   *
   * This hashed `html ?? body` and left `threadId` out. Both are the same defect: a field the
   * SERVER is given that the fingerprint cannot see, so two different messages hash alike.
   *
   *  · `html ?? body` — a rich message carries BOTH, and the plain-text half is what a recipient
   *    whose client refuses HTML actually reads. It also hid the signature on a rich send: the
   *    signature is appended to `body` and to `html` (`withSignature`), so a plain-text-only
   *    change to it was invisible.
   *  · `threadId` — sent, and never hashed.
   *
   * `sendFingerprintFieldsCovered` in the test dir is the census that keeps this list equal to the
   * mutation's own fields, so a field added to the wire cannot quietly stay out of the identity.
   */
  /**
   * ── THE DRAFT ROW IS THE CONTAINER, NOT THE CONTENT, AND HASHING IT WAS THE DEFECT ──────────
   *
   * `m.draftId ?? ""` used to sit here. A row is not something the person wrote: it appears
   * part-way through one message's life (the first autosave), it is REPLACED when a send makes
   * its own, and it is absent entirely for a press that beat the first save. So one unchanged
   * message hashed as three different messages depending on which moment the press happened in —
   * and a fingerprint that changes without the content changing is precisely how a resume misses
   * and a second Idempotency-Key is minted for mail that may already have gone.
   *
   * Which ROW a record names is still written down ({@link SendLock.draftId}, kept current by
   * {@link attachSendLockDraft}); it is diagnostic, and nothing branches on it. Which MESSAGE a
   * record is of is `subject`/`session` and this hash. `sendFingerprintFieldsCovered` in
   * `send-lock-durable.test.tsx` exempts `draftId` by name for this reason.
   */
  const parts = [
    m.inReplyTo ?? "", m.forwardOf ?? "", m.mailboxId ?? "",
    m.threadId ?? "",
    addrs(m.to), addrs(m.cc), addrs(m.bcc),
    m.subject ?? "", m.body ?? "", m.html ?? "", m.sendAt ?? "",
    // BY CONTENT — see the header. The length rides along beside the content hash rather than
    // instead of it, so telling two files apart no longer depends on them differing in size.
    // Hashed per attachment rather than concatenated into `parts`, which would allocate a second
    // copy of every byte the person attached.
    JSON.stringify((m.attachments ?? []).map((a) => [
      a.filename, a.contentType, a.contentBase64.length, fnv1a(a.contentBase64),
    ])),
  ].join("\u0000");
  return fnv1a(parts);
}

/**
 * ── THE FINGERPRINT 0.14.0 WROTE, KEPT SO ITS RECORDS CAN STILL BE READ ─────────────────────
 *
 * Copied field for field and join for join from `apps/webapp/app/shell/send-lock.ts` at the
 * released `v0.14.0` tag. It is FROZEN: it is not a second implementation of the identity but a
 * decoder for jars that are already on people's disks, and changing it would silently stop
 * matching the records it exists for. `sendFingerprint` above is the live one.
 *
 * What 0.14.0 hashed, and every way it differs from the current algebra:
 *  · recipients by LOWERCASED ADDRESS ONLY, joined with `,` — no display name, no encoding;
 *  · `html ?? body` as ONE field — a rich message's plain-text half was never hashed;
 *  · no `threadId`;
 *  · attachments as `filename:contentType:contentBase64.length`, joined `|` — by SIZE, not
 *    content.
 * Same `\u0000` join of the parts and the same FNV-1a over the result, which is why `fnv1a` is
 * shared rather than re-inlined: 0.14.0's loop is byte for byte the function above.
 *
 * ── WHY A RELEASED BUILD'S RECORD HAS TO BE DECODED AT ALL ──────────────────────────────────
 *
 * The managed web app flips every browser at once. A browser holding an unresolved 0.14.0 record
 * at that moment computes a different fingerprint for the same unchanged message under the new
 * algebra, so the record would not be recognised, a second key would be minted, and where the
 * first send had reached the server the mail would go out twice. The changelog's headline promise
 * for this feature is that a send which could not be confirmed is never sent twice, so this is a
 * release matter and not a tidiness one.
 */
export function legacySendFingerprint_0_14_0(m: MailSend): string {
  const addrs = (xs: ReadonlyArray<{ address: string }> | undefined): string =>
    (xs ?? []).map((a) => a.address.toLowerCase()).join(",");
  const parts = [
    m.inReplyTo ?? "", m.forwardOf ?? "", m.draftId ?? "", m.mailboxId ?? "",
    addrs(m.to), addrs(m.cc), addrs(m.bcc),
    m.subject ?? "", m.html ?? m.body ?? "", m.sendAt ?? "",
    (m.attachments ?? []).map((a) => `${a.filename}:${a.contentType}:${a.contentBase64.length}`).join("|"),
  ].join("\u0000");
  return fnv1a(parts);
}

/**
 * ── THE FINGERPRINT 0.14.1 WROTE, KEPT FOR THE SAME REASON THE 0.14.0 ONE IS ────────────────
 *
 * Copied field for field and join for join from `apps/webapp/app/shell/send-lock.ts` at the
 * released 0.14.1 build. FROZEN: a decoder for jars that are on people's disks right now, not a
 * second implementation of the identity. {@link sendFingerprint} above is the live one.
 *
 * It differs from the live algebra in exactly one place — it folds `m.draftId` into the hash — and
 * that one place is the whole reason for the format bump. A browser holding an unresolved 0.14.1
 * record when the managed web app flips computes a different hash for the same unchanged message
 * under the new algebra; without this the record would not be recognised, a second key would be
 * minted, and the mail would go out twice where the first send had reached the server.
 *
 * A `v: 2` record is compared against THIS; a `v: 3` record against {@link sendFingerprint}. The
 * version is what tells them apart, which is why it was bumped rather than left at 2 as the 0.14.1
 * change itself was — see {@link SEND_LOCK_FORMAT}.
 *
 * `send-lock-durable.test.tsx` pins the OUTPUT of the released build's own code over fixed
 * messages, extracted with `git show` from the 0.14.1 tag's tree and run unmodified, so a
 * transcription slip here shows up as a mismatch rather than as two copies of one assumption.
 */
export function legacySendFingerprint_0_14_1(m: MailSend): string {
  const addrs = (xs: ReadonlyArray<{ name?: string | null; address: string }> | undefined): string =>
    JSON.stringify((xs ?? []).map((a) => [a.name ?? null, a.address.toLowerCase()]));
  const parts = [
    m.inReplyTo ?? "", m.forwardOf ?? "", m.draftId ?? "", m.mailboxId ?? "",
    m.threadId ?? "",
    addrs(m.to), addrs(m.cc), addrs(m.bcc),
    m.subject ?? "", m.body ?? "", m.html ?? "", m.sendAt ?? "",
    JSON.stringify((m.attachments ?? []).map((a) => [
      a.filename, a.contentType, a.contentBase64.length, fnv1a(a.contentBase64),
    ])),
  ].join("\u0000");
  return fnv1a(parts);
}

/**
 * HOW LONG A PERSISTED KEY IS STILL WORTH RESUMING.
 *
 * Seven days, and the number is chosen against the SERVER's two horizons rather than invented.
 * `idempotency_keys` expires at 24 h, so past a day a resumed key no longer replays a stored
 * RESPONSE — but `outbound_sends` is a permanent reservation and its `UNIQUE (account_id,
 * idempotency_key)` still refuses a second delivery, which is the half that matters here. Seven
 * days is therefore comfortably inside the guarantee that protects the recipient and well past any
 * window in which a person still believes the message is going.
 *
 * Past it the record is dropped: a week-old unsettled lane is wreckage, and the honest thing is to
 * let the next press be a new send rather than to resume a key whose row nobody will ever look at.
 */
export const SEND_LOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Every owner's lane key starts here. Exported so sign-out can sweep them without respelling it. */
export const SEND_LOCKS_PREFIX = "ohmail.send.locks.";

/** One key per ACCOUNT, holding every lane — see the header for why it is owner-keyed. */
export function sendLocksKey(owner: string | null = storageOwner()): string {
  return `${SEND_LOCKS_PREFIX}${owner ?? "local"}`;
}

function isLock(x: unknown): x is SendLock {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  // THE FOUR FIELDS THAT MAKE A CLAIM A CLAIM, required at every version: which lane, which key,
  // when, and how to read the rest.
  if (typeof r.v !== "number" || !Number.isInteger(r.v) || r.v < 1) return false;
  if (typeof r.lane !== "string" || r.lane.length === 0) return false;
  if (typeof r.key !== "string" || r.key.length === 0) return false;
  if (typeof r.at !== "number") return false;
  /**
   * A RECORD FROM A FORMAT THIS BUILD DOES NOT KNOW IS CARRIED, NOT PARSED.
   *
   * Everything below is this build's field set, and a later shape is free to have moved any of
   * it. Refusing such a record here would DELETE it — `load` drops what it cannot recognise and
   * every writer saves the filtered list back — and deleting a newer install's record is how a
   * downgrade loses the only evidence that a message may already have been delivered. Nothing
   * reads these fields off a higher-version record: it is never matched, rewritten or released.
   */
  if (r.v > SEND_LOCK_FORMAT) return true;
  return typeof r.fp === "string"
    && (r.subject === undefined || typeof r.subject === "string")
    && (r.session === undefined || typeof r.session === "string")
    && (r.unverified === undefined || typeof r.unverified === "boolean");
}

/**
 * ── THE 0.14.0 RECORD IS REWRITTEN ONCE, HERE, AND IT NEVER RESUMES A KEY ───────────────────
 *
 * A record in the pre-0.14.1 shape ({@link mayMatchLegacy}) is an unsettled send from the
 * RELEASED build: 0.14.0 deleted a record at a terminal outcome exactly as this build does, so
 * one that is still in the jar is a send whose fate nobody observed. What this build cannot do
 * is decide that such a record names the message in hand.
 *
 * It used to try. The press decoded the record with 0.14.0's own algebra and, on a match,
 * RESUMED its key — and 0.14.0's algebra is blind in four places this one is not: recipients by
 * address alone (no display name), `html ?? body` as one field, no `threadId`, and an attachment
 * by its byte LENGTH rather than its content. So a message the person had CHANGED in any of those
 * four ways hashed as the unchanged one, was handed the old key, and the server — which never
 * sends twice under a key it has reserved — replayed the first send's stored result at it. The
 * editor read `confirmed`, cleared the scratch and said "Sent." about a message that never left.
 * A silently unsent mail is the worse half of the pair this file exists to prevent.
 *
 * The blind spots cannot be narrowed from this side: the record carries one hash and no evidence
 * of which fields produced it. So the decode answers a smaller question than it used to. The
 * record becomes an UNRESOLVED record of this build's shape carrying its 0.14.0 fingerprint and
 * NO name — no `subject`, no `session`, because 0.14.0 recorded neither and inventing one here
 * would park the wrong message. A nameless unresolved record parks by the only identity it has
 * (`unresolvedNames` in `mail-send.ts` compares BOTH algebras against it), so the surface shows
 * the unconfirmed warning for that message and Send is refused for it. The person checks their
 * Sent folder and decides; a message they change is a different message, gets a key of its own,
 * and goes out once.
 *
 * ── WHY AT `load`, AND WHY IT IS IDEMPOTENT ────────────────────────────────────────────────
 *
 * Every reader comes through here, so the park is established before any press rather than by
 * one — the press is the thing being refused. `v` moves to this build's format, which is what
 * makes {@link mayMatchLegacy} false on the next pass: the rewrite happens once and the second
 * read takes the ordinary path. The fingerprint is NOT touched, and that is deliberate: it is
 * still a 0.14.0 hash and the reader that compares it knows so.
 */
/**
 * ── `null` IS NOT `[]`, AND COLLAPSING THEM WAS A FAIL-OPEN ─────────────────────────────────
 *
 * This returned `[]` for everything its `catch` swallowed, so a browser that refuses this app
 * access to its own storage — a private window, a profile with site data blocked — read as *a
 * browser with no unresolved sends*. Every reader then answered "nothing is held": the reopen took
 * the recovery door, the autosave minted a row, the settled discard deleted one. Each of those is
 * a decision made on evidence that was never obtained.
 *
 * `null` = THE JAR COULD NOT BE READ. `[]` = the jar was read and holds nothing, which genuinely
 * admits. {@link holdOf} maps the first to `unknown` and every recovery fails closed on it, while
 * the press is still admitted (see invariant S(4) and the header's second decision).
 *
 * ONLY A THROWN ACCESSOR IS `null`. Content that will not parse is a jar that CAN be read whose
 * bytes are garbage: the next write replaces it and the surface recovers, whereas answering
 * `unknown` there would park the composer permanently with no exit — a jar nobody can repair. So
 * a `JSON.parse` failure keeps the old `[]`, and only `localStorage` itself throwing is unknown.
 *
 * ── AND A `v: 2` RECORD IS NOT REWRITTEN ────────────────────────────────────────────────────
 *
 * The decode below is 0.14.0's alone ({@link mayMatchLegacy} names its format). A released 0.14.1
 * record decodes perfectly well under {@link legacySendFingerprint_0_14_1}; rewriting it would
 * throw away the `subject` and `session` that are the only names its message has.
 */
function load(owner: string | null = storageOwner()): SendLock[] | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(sendLocksKey(owner));
  } catch {
    return null;
  }
  try {
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: SendLock[] = parsed.filter(isLock);
    let decoded = false;
    const out = rows.map((r) => {
      if (!mayMatchLegacy(r)) return r;
      decoded = true;
      return { ...r, v: SEND_LOCK_FORMAT, unverified: true };
    });
    if (decoded) save(out, owner);
    return out;
  } catch {
    return [];
  }
}

/** What the jar holds, with an unreadable jar read as empty — for the readers that admit on it. */
function loadOrEmpty(owner: string | null = storageOwner()): SendLock[] {
  return load(owner) ?? [];
}

function save(rows: SendLock[], owner: string | null = storageOwner()): void {
  try {
    if (rows.length === 0) window.localStorage.removeItem(sendLocksKey(owner));
    else window.localStorage.setItem(sendLocksKey(owner), JSON.stringify(rows));
  } catch {
    /* private mode, or a full quota — the lock is as durable as the tab, exactly as before */
  }
}

/**
 * THE KEY THIS LANE'S UNSETTLED SEND OF *THIS MESSAGE* IS GOING OUT UNDER, or `null`.
 *
 * Both halves of the identity are required — see {@link sendFingerprint} for the message half and
 * why a lane alone is not enough. A record for the lane whose fingerprint does not match is a key
 * minted for a message the user has since replaced; it is DROPPED here rather than resumed, so the
 * new message gets a key of its own and the stale one stops being offered to anybody.
 *
 * The TTL is applied on READ and swept in the same pass, so an expired record can never be resumed
 * and can never accumulate. `nowMs` is injected for the same reason it is on the Screener's
 * journal: the caller's clock is the engine's clock, and a guard that reads its own is a guard
 * nobody can drive.
 */
/**
 * IS THIS RECORD STILL WORTH KEEPING? One answer, shared by every reader.
 *
 * Seven days is the right limit for wreckage — a lane nobody ever settled. An unverified send is
 * not wreckage: it is a message that may be sitting in somebody's inbox, and this record is the
 * only thing that still names the key it went under. So it does not age out.
 *
 * Shared rather than repeated because it WAS repeated, and the two copies disagreed: one exempted
 * unverified locks and the other did not, and the one that did not also persisted its own answer.
 */
function isLive(r: SendLock, nowMs: number): boolean {
  /**
   * A RECORD FROM A LATER FORMAT IS NOT AGED OUT, and this arm is why the answer is not simply
   * the two below it.
   *
   * `at` is the only field of a newer shape this build may read, and the age limit acts on the
   * FILTERED list: both readers persist what they keep, so a downgrade that ran eight days after a
   * newer install left an unresolved record would have deleted the one thing naming the key that
   * send went under — and re-upgrading would then mint a fresh key for a message that may already
   * have been delivered. `unverified` cannot answer for such a record either: the flag means
   * whatever the build that wrote it decided, so reading it is a guess. The record is carried, as
   * everywhere else in this file.
   */
  if (r.v > SEND_LOCK_FORMAT) return true;
  return r.unverified === true || nowMs - r.at <= SEND_LOCK_TTL_MS;
}

export function resumeSendLock(
  lane: string,
  id: SendIdentity,
  nowMs: number,
  owner: string | null = storageOwner(),
): string | null {
  const rows = load(owner);
  // AN UNREADABLE JAR RESUMES NOTHING and mints nothing: the press goes out under a fresh
  // session-only key, which is the admit arm of invariant S(4). It also writes nothing back —
  // `save` no-ops on the same refusal — so the sweep below cannot delete evidence it never read.
  if (rows === null) return null;
  if (rows.length === 0) return null;
  const live = rows.filter((r) => isLive(r, nowMs));
  /**
   * ── ONE LANE MAY HOLD SEVERAL RECORDS, AND ONLY ONE OF THEM IS ORDINARY ────────────────────
   *
   * This used to take the FIRST record for the lane and answer about it alone. That was true
   * while a lane could hold at most one record, and an unresolved send broke it: the record has
   * to outlive the next press (it is the only thing naming the key a message may already have
   * gone under), so the lane now carries the unresolved ones alongside whichever ordinary claim
   * is current. Reading by `(lane, fingerprint)` is what keeps them apart — see
   * {@link unverifiedSendIntents} for the other half.
   *
   * ── ONE COMPARISON, IN THIS BUILD'S ALGEBRA, AND NO DECODE ─────────────────────────────────
   *
   * A press never decodes a 0.14.0 record and never resumes its key — see {@link load}, which
   * rewrites such a record into a nameless UNRESOLVED one before any reader sees it. That record
   * is then exempt from the spent-record sweep below (it is `unverified`), it parks its own
   * message at the surface, and it is not offered here to any message at all.
   */
  /**
   * ── A RECORD RESUMES ACROSS SESSIONS ONLY WHEN IT IS UNRESOLVED — invariant S, decision 1 ────
   *
   * An ordinary claim belongs to the message-in-progress it was pressed in. The compose lane is
   * one lane for every message this browser will ever write, so a claim left behind by a message
   * that was replaced (a new compose, a mail link, a contact's Write — each of which re-mints the
   * session) would otherwise be handed to whatever is on screen next, and the server replays the
   * FIRST send's stored result at it: "Sent." about a message that never left.
   *
   * An UNRESOLVED record is the opposite case and keeps resuming regardless of session: it is the
   * only thing naming the key a message may already have gone under, and refusing to resume it is
   * precisely how the next press mints a fresh one for mail that is already delivered.
   *
   * A record with no session of its own (a reply, a forward, a 0.14.0 rewrite) is not scoped by
   * this: it is named by the message it answers, which no session can change.
   */
  const sessionAdmits = (r: SendLock): boolean =>
    r.unverified === true || r.session === undefined || id.session === null
    || r.session === id.session;
  const found = live.find(
    (r) => r.lane === lane && r.fp === fingerprintFor(r, id) && sessionAdmits(r),
  );
  // A different fingerprint means the key does not name THIS content, so it cannot be resumed and
  // the record is spent — EXCEPT an unverified one, which is kept regardless. Deleting it is how
  // reopening a draft and editing it turned into a fresh key for a message that may already have
  // been delivered. A record from a LATER format is exempt too: this build cannot read what its
  // fingerprint means, and a downgrade must not delete a newer install's evidence.
  const kept = live.filter((r) => !(
    r.lane === lane && r.fp !== fingerprintFor(r, id) && r.unverified !== true
    && r.v <= SEND_LOCK_FORMAT
  ));
  if (kept.length !== rows.length) save(kept, owner);
  return found?.key ?? null;
}

/**
 * IS THIS RECORD IN THE PRE-0.14.1 SHAPE? — the only reliable way to spot a 0.14.0 record.
 *
 * `v` cannot answer it. 0.14.0 wrote `v: 1` and 0.14.1 changed what a fingerprint hashes WITHOUT
 * bumping it, so the number says the same thing about two different algebras. The SHAPE does
 * answer it: `subject` arrived with 0.14.1 and `session` with the fix above it, and 0.14.0's
 * record type had neither field — its whole interface was `v, lane, key, at, draftId, fp`. So a
 * record carrying neither name was written before either existed.
 *
 * A 0.14.1 record for a message this browser could not name at all would also carry neither — but
 * such a browser has no writable jar (`sendSubject` answers `undefined` only when the session id
 * could not be read, which is the same failure that stops the record being saved), so it is not a
 * state that reaches storage. `v < SEND_LOCK_FORMAT` is required as well, which keeps this off
 * anything this build or a later one wrote — and it is what makes {@link load}'s rewrite happen
 * once: the rewrite moves `v`, so the next read is no longer a legacy read.
 *
 * WHAT IT NO LONGER DOES is guard a resume. It named the records whose key a press was allowed to
 * take over, which is the decision {@link load}'s header withdraws: this predicate now only says
 * "the outcome of this send was never observed and this build cannot name what it was of".
 */
function mayMatchLegacy(r: SendLock): boolean {
  return r.v <= LAST_0_14_0_FORMAT && r.subject === undefined && r.session === undefined;
}

/**
 * WHICH SPELLING OF THIS MESSAGE A STORED RECORD'S FINGERPRINT IS IN — the version decides.
 *
 * `v: 2` is the released 0.14.1 algebra ({@link legacySendFingerprint_0_14_1}, `draftId` folded
 * in); `v: 3` is this build's. Comparing every record against one hash is what made the 0.14.0 →
 * 0.14.1 flip a duplicate-delivery window, and it is the same window here.
 *
 * A record the 0.14.0 decode rewrote carries `v: 3` and a 0.14.0 fingerprint on purpose: it is
 * NAMELESS and must match no message by hash at all, which is exactly what comparing it against
 * this build's algebra achieves. Its park is `unresolvedNames`' nameless arm, which tries all
 * three spellings.
 */
function fingerprintFor(r: SendLock, id: SendIdentity): string {
  return r.v <= LAST_0_14_1_FORMAT ? id.legacyFp0141 : id.fp;
}

/**
 * WHAT ONE MESSAGE IN HAND IS, in every spelling a stored record could be using.
 *
 * Assembled once per press rather than recomputed at each comparison: `sendFingerprint` hashes
 * every attachment's contents, and asking for it twice would put the bytes through a hash twice.
 */
export interface SendIdentity {
  /** {@link sendFingerprint} — this build's algebra. */
  fp: string;
  /**
   * {@link legacySendFingerprint_0_14_0} — the released 0.14.0 algebra.
   *
   * NOT a resume comparison any more: no press decodes a 0.14.0 record (see {@link load}). It is
   * the identity's second spelling, carried so a reader comparing this message against a NAMELESS
   * unresolved record — whose fingerprint is in that algebra and is the only identity it has — has
   * both hashes from the one assembly rather than re-hashing every attachment to get the second.
   */
  legacyFp: string;
  /**
   * {@link legacySendFingerprint_0_14_1} — the released 0.14.1 algebra, `draftId` folded in.
   *
   * The spelling every `v: 2` record in a jar on somebody's disk right now is written in. Carried
   * on the identity rather than recomputed at each comparison for the reason the other two are:
   * the hash walks every attachment's base64, and asking for it twice puts the bytes through a
   * hash twice on the render path that decides whether Send is pressable.
   */
  legacyFp0141: string;
  /** {@link sendSubjects} — every name the message answers to. */
  subjects: ReadonlyArray<string>;
  /** The compose session the press is in, or `null` off the compose lane. */
  session: string | null;
  /** The draft row the message carries, when it has one. */
  draftId: string | null;
}

export function sendIdentity(m: MailSend, session: string | null = null): SendIdentity {
  return {
    fp: sendFingerprint(m),
    legacyFp: legacySendFingerprint_0_14_0(m),
    legacyFp0141: legacySendFingerprint_0_14_1(m),
    subjects: sendSubjects(m, session),
    session,
    draftId: m.draftId ?? null,
  };
}

/**
 * THE KEY FOR A FINGERPRINT ALONE — the door for a caller that has no message.
 *
 * It cannot ask the 0.14.0 question, and says so by handing the same fingerprint in as both: the
 * legacy branch is written to skip when they are equal, so this door is provably decode-free
 * rather than accidentally so. Every production press goes through {@link resumeSendLock} with a
 * real identity.
 */
export function readSendLock(lane: string, fp: string, nowMs: number, owner: string | null = storageOwner()): string | null {
  return resumeSendLock(lane, {
    fp, legacyFp: fp, legacyFp0141: fp, subjects: [], session: null, draftId: null,
  }, nowMs, owner);
}

/**
 * CLAIM A LANE UNDER A KEY — synchronous, and it must complete BEFORE the verb is expressed.
 *
 * That order is the whole guarantee. A key written after `engine.mutate` returns would leave the
 * exact window this file exists to close: a process killed between the POST and the write comes
 * back with the mail possibly sent and no record of the key it went under.
 */
export function claimSendLock(lock: SendLock, owner: string | null = storageOwner()): void {
  /**
   * IT EVICTS THE LANE'S ORDINARY CLAIM AND NOTHING ELSE.
   *
   * This filtered on the lane alone, which deleted an UNRESOLVED record the moment anybody
   * pressed Send on that surface again — the record whose entire job is to outlive that press.
   * The lane keeps at most one ordinary claim (a fresh press replaces it, exactly as before) and
   * every unresolved record it has, minus any that names this same message: that one IS this
   * claim, and two rows for one message would answer twice about it.
   */
  // AN UNREADABLE JAR IS EMPTY HERE ON PURPOSE: there is nothing to evict and `save` will no-op,
  // so the claim is as durable as the tab — exactly what it was before this file existed.
  const rows = loadOrEmpty(owner).filter((r) => r.lane !== lock.lane
    ? true
    // A record from a LATER format is not this build's to evict, ordinary or not.
    : (r.unverified === true && r.fp !== lock.fp) || r.v > SEND_LOCK_FORMAT);
  /**
   * THE VERSION IS STAMPED HERE, not taken from the caller.
   *
   * A caller can never legitimately write an older shape, and `v` is what every later reader
   * branches on — including the 0.14.0 decode, which must never fire on a record this build
   * wrote. Leaving the number in the caller's hands made it a literal at the one call site that
   * had to be remembered on every format change, and it was not remembered on the last one:
   * 0.14.1 changed the fingerprint algebra and still wrote `v: 1`, which is why the decode below
   * has to read the record's shape instead of its version.
   */
  rows.push({ ...lock, v: SEND_LOCK_FORMAT });
  save(rows, owner);
}

/**
 * Release ONE MESSAGE's claim on a lane at a TERMINAL outcome — see the header for why `queued`
 * is not one.
 *
 * The fingerprint is required rather than optional, and that is the whole correction. A lane can
 * hold an unresolved record beside a live claim, so "release the lane" is no longer a statement
 * anybody can make: releasing everything would delete the record saying an earlier message may
 * already have been delivered, and an optional fingerprint would make that the DEFAULT for any
 * caller that did not think about it. A confirmed or failed outcome for the message named here
 * releases that message's record — including its unresolved one, because an outcome the session
 * has now observed is no longer unknown — and leaves every other record on the lane alone.
 */
export function releaseSendLock(lane: string, fp: string, owner: string | null = storageOwner()): void {
  // Nothing read, nothing to release — and nothing written, so an unreadable jar cannot lose a
  // record it never handed over.
  const rows = loadOrEmpty(owner);
  const kept = rows.filter((r) => !(r.lane === lane && r.fp === fp));
  if (kept.length !== rows.length) save(kept, owner);
}

/**
 * Every live claim, oldest first — for a restart's adoption pass.
 *
 * IT SHARES `isLive` WITH `readSendLock`, and that is the point of the helper. This filtered on
 * the age limit ALONE while its sibling exempted unverified locks from it, and it PERSISTS what
 * it filters — so the first caller anybody wrote would, seven days on, delete the one record
 * saying a message may already have been delivered. `unverifiedSendLock` would then answer false,
 * the composer would come back live, and the next press would mint a fresh key.
 *
 * There is no such caller today, which is exactly what makes it worth fixing rather than leaving:
 * an unreachable half of a pair is a trap for whoever reaches it, and this one had a docblock
 * inviting them to.
 */
export function allSendLocks(nowMs: number, owner: string | null = storageOwner()): SendLock[] {
  const rows = loadOrEmpty(owner);
  if (rows.length === 0) return [];
  const live = rows.filter((r) => isLive(r, nowMs));
  if (live.length !== rows.length) save(live, owner);
  // RETURNED, not stored: a record from a later format stays in the jar and stays out of this
  // list, because a caller reading fields off it would be reading a shape this build never wrote.
  return live.filter((r) => r.v <= SEND_LOCK_FORMAT).sort((a, b) => a.at - b.at);
}

/**
 * WHICH MESSAGE AN UNRESOLVED SEND BELONGS TO — the identity a lock is scoped to.
 *
 * Both halves, because neither alone is an identity. The fingerprint changes the moment the
 * person edits what they wrote, and a draft that is reopened and edited is still the same
 * message — that is the case {@link readSendLock} exists for. A draft id is only an identity
 * when there IS one: an interactive compose that never autosaved carries `null`, and `null`
 * matching `null` would make every such compose the same message, which is precisely the
 * lane-only defect this file's header describes.
 */
export interface SendIntent {
  /**
   * EVERY IDENTITY the message this key was minted for answers to — {@link sendSubjects}.
   *
   * A list rather than one string, because one message-in-progress carries more than one name and
   * acquires them at different moments. A compose is `compose:<session>` from the first press and
   * becomes `draft:<id>` as well the moment autosave gives it a row; a draft reopened after the
   * session was cleared has only the row. Comparing ONE name against ONE name meant a message
   * whose row appeared between two presses read as a different message and sent twice.
   *
   * EMPTY means this browser could not name the message at all — no row, no session (a jar it
   * cannot write, a state built by hand). It is not evidence of a different message, so the
   * reader fails closed on it, and the fingerprint is the only comparison left.
   */
  subjects: ReadonlyArray<string>;
  /** {@link sendFingerprint} of the message the key was minted for. */
  fp: string;
}

/**
 * ── WHAT A SEND IS *OF* — the identity an unresolved attempt parks ───────────────────────────
 *
 * Not the fingerprint. The fingerprint changes the moment the person edits what they wrote, and an
 * edited reply is the same reply — so keying the park on it was a designed escape from the lock:
 * type one character into a reply whose outcome nobody knows, press Send, and a fresh key goes out
 * for a message that may already have been delivered.
 *
 * The subject is the thing being answered or written, which an edit does not change:
 *  · a reply — the parent message;
 *  · a forward — the message being forwarded;
 *  · a draft-backed compose — the draft row;
 *  · a new compose with no row yet — the compose session (`composeSessionId`), which lives exactly
 *    as long as the message-in-progress does. `null` here means this browser cannot name it, and
 *    that is NOT "a new message": see the fail-closed arm in `canSend`.
 *
 * The fingerprint keeps its own job, which is a different question: whether a stored key may be
 * RESUMED for the content in hand. Two messages with one subject (an edit) must not share a key;
 * one message pressed twice must.
 */
/**
 * EVERY NAME THIS MESSAGE ANSWERS TO, most specific first — the identity a park compares.
 *
 * ── WHY IT IS A SET, MEASURED ───────────────────────────────────────────────────────────────
 *
 * {@link sendSubject} returns ONE name and prefers the draft row over the compose session. That
 * preference is right for what to WRITE and wrong for what to COMPARE, because the row appears
 * part-way through the life of a message: a compose pressed with no row is recorded as
 * `compose:<session>`, autosave then creates a row, and the next press of the SAME UNEDITED
 * MESSAGE computes `draft:<id>` — a different string, no match, nothing parked. On a send whose
 * outcome the server could not confirm that is a second delivery: the surface presented `idle`,
 * the button lit up, the press minted a second key, and the recipient held two copies while the
 * sender's Sent folder held one, so neither side revealed it.
 *
 * The two names are not redundant and neither is available everywhere:
 *  · a compose that never autosaved has a session and no row;
 *  · a draft reopened after the compose session was cleared has a row and a NEW session;
 *  · a row that autosave replaces (its create having been undone, or the row consumed by a send)
 *    changes `draft:<id>` under one unchanged session.
 *
 * So both are collected and a record parks a message when the record's set and the message's set
 * INTERSECT. A reply and a forward are named by the message they answer, which nothing can
 * change under them, so they answer to exactly one name and the session is not consulted.
 *
 * EMPTY means this browser can name the message by nothing at all — no row and no session, which
 * is a jar it cannot write. Callers read that as "unnameable", never as "a new message".
 */
export function sendSubjects(m: MailSend, session: string | null = null): string[] {
  if (typeof m.forwardOf === "string" && m.forwardOf.length > 0) return [`fwd:${m.forwardOf}`];
  if (m.inReplyTo !== null) return [`reply:${m.inReplyTo}`];
  const out: string[] = [];
  if (m.draftId !== undefined && m.draftId !== null && m.draftId.length > 0) out.push(`draft:${m.draftId}`);
  if (session !== null) out.push(`compose:${session}`);
  return out;
}

/**
 * THE ONE NAME A RECORD IS WRITTEN UNDER — the first of {@link sendSubjects}, unchanged.
 *
 * The record keeps a single `subject` for the shape it has always had, and carries the session
 * beside it in {@link SendLock.session}. Reading is what needs the whole set.
 */
export function sendSubject(m: MailSend, session: string | null = null): string | undefined {
  return sendSubjects(m, session)[0];
}

/**
 * EVERY NAME A STORED RECORD ANSWERS TO — the reading half of {@link sendSubjects}.
 *
 * The record's own `subject` plus the compose session it was pressed in. Both, for the same
 * reason the message side collects both: the record was written at one moment in the message's
 * life and is read at another, and whichever name the two moments have in common is the one that
 * has to decide.
 */
function lockSubjects(r: SendLock): string[] {
  const out: string[] = [];
  if (r.subject !== undefined) out.push(r.subject);
  const fromSession = r.session === undefined ? null : `compose:${r.session}`;
  if (fromSession !== null && !out.includes(fromSession)) out.push(fromSession);
  return out;
}

/**
 * WHICH SENDS ON THIS LANE ARE IN THE TERMINAL-UNKNOWN STATE, according to DURABLE storage.
 *
 * The composer's own phase is component state and does not survive reopening the draft, a reload,
 * or another tab — and those are exactly the paths by which a person arrives back at a send that
 * may already have gone. This is the fact that outlives all of them.
 *
 * ── IT ANSWERS *WHICH*, NOT *WHETHER*, AND THAT IS THE CORRECTION ───────────────────────────
 *
 * It used to answer a boolean about the LANE. The compose surface has one lane for every message
 * this browser will ever write, so one ambiguous delivery parked that lane for good: the surface
 * read `unverified`, `canSend` refuses `unverified`, the record is exempt from the age limit on
 * purpose, and Send and Send Later were therefore disabled for every future new message — with
 * the only exit being the reload that mints a fresh key for a message that may already be gone.
 * Naming the messages lets the uncertain one stay protected while a genuinely different message
 * sends, which is the whole of what a person needs here.
 */
export function unverifiedSendIntents(lane: string, owner: string | null = storageOwner()): SendIntent[] {
  // EMPTY on an unreadable jar, and that is the ADMIT arm of invariant S(4) rather than an
  // oversight: this feeds `canSend`, and a browser that will not let this app keep a record must
  // still be able to send. The recovery sites fail closed instead, through {@link holdOf}.
  return loadOrEmpty(owner)
    /**
     * A LATER FORMAT'S RECORD IS NOT INTERPRETED HERE, and it is not deleted either.
     *
     * Its `fp` and its names mean whatever the build that wrote it decided, so reading them would
     * be a guess dressed as a fact — and a wrong name here is a park on the wrong message. It
     * stays in the jar untouched (`isLock` carries it, every writer preserves it), which is the
     * protection that matters: the build that wrote it reads it correctly the moment the install
     * is upgraded back. A downgrade in the window shows no park for that one message.
     */
    .filter((r) => r.lane === lane && r.unverified === true && r.v <= SEND_LOCK_FORMAT)
    .map((r) => ({ subjects: lockSubjects(r), fp: r.fp }));
}

/**
 * ── IS THIS COMPOSE A MESSAGE WE ARE STILL WAITING TO LEARN THE FATE OF? ────────────────────
 *
 * THE ONE GUARD, and it is one function because it was measured failing in two places that had to
 * agree and did not. Both are moments at which this browser decides whether the message in front
 * of it is a NEW one:
 *
 *  · REOPENING a draft from the list (`openDraft`) — asked with the row and no session, because
 *    the session at that moment is still the one being left behind and every draft in the account
 *    would answer to it. The row alone decides which message is being opened.
 *  · COMING BACK after a reload (`useComposeAutosave`'s adoption) — asked with the row this
 *    surface was holding AND the session it came back to, because a send pressed before autosave
 *    had written anything is named by the session alone and there is no row to ask about.
 *
 * Answering `true` means: do not mint a row for this, do not start a new session for it, and do
 * not treat it as recovered. It is the message the record names, it is parked, and the surface
 * says so.
 *
 * ── WHAT WENT WRONG WHEN THE TWO SITES DID NOT SHARE IT ────────────────────────────────────
 *
 * Measured end to end, twice, one recipient holding two copies each time. The reopen minted a row
 * and re-minted the session, so neither name the record carried was on the message any more. And
 * EARLIER than that, the reload alone did it: the adoption found the row moved past `draft`,
 * dropped it, and let the next pause create a fresh one — so the drafts list held TWO rows for one
 * message before anybody reopened anything, and the fresh row was a message the record could not
 * recognise.
 *
 * A row is matched by either name a record can carry it under: the subject it was minted with
 * (`draft:<id>`), and the row it ACQUIRED afterwards ({@link attachSendLockDraft}). They usually
 * agree; when the row moves they do not, and the row still in the drafts list is the one named by
 * the subject. That reading is {@link unresolvedSendRows}, called from here rather than repeated.
 *
 * A record may name NO row — a send pressed before autosave had written anything carries
 * `draftId: null` and `compose:<session>` — so the session arm is not a fallback for the row arm.
 * It is the only name that message will ever have.
 */
export function parkedComposeMessage(
  lane: string,
  draftId: string | null,
  session: string | null,
  owner: string | null = storageOwner(),
): boolean {
  return parkedComposeRecord(lane, draftId, session, owner) !== null;
}

/** The identity a park holds a message by — {@link parkedComposeRecord}. */
export interface ParkedIdentity {
  /** The compose session the unresolved send was pressed in, when it had one. */
  session: string | null;
  /** The draft row the record names, when it has one. */
  draftId: string | null;
}

/**
 * THE SAME QUESTION, ANSWERED WITH THE NAMES — {@link parkedComposeMessage} is this, made boolean.
 *
 * The reopen needs more than "yes": it has to put the message's identity BACK. A door in between
 * (writing to a contact, a mail link from outside) legitimately starts a new message and mints a
 * new session, so the browser can arrive back at an unconfirmed message holding neither of the
 * names its record carries. Answering only `true` there produced a surface that KNEW the message
 * was parked and then presented it under a session the record had never heard of: no warning,
 * Send live, one press and a second copy — the same ending as the door this replaced, reached
 * from a different direction.
 *
 * `null` = not parked. Otherwise the record's own names, for the caller to restore.
 */
export function parkedComposeRecord(
  lane: string,
  draftId: string | null,
  session: string | null,
  owner: string | null = storageOwner(),
): ParkedIdentity | null {
  const rows = loadOrEmpty(owner)
    .filter((r) => r.lane === lane && r.unverified === true && r.v <= SEND_LOCK_FORMAT);
  if (session !== null) {
    const named = rows.find((r) => lockSubjects(r).includes(`compose:${session}`));
    if (named) return { session: named.session ?? session, draftId: named.draftId };
  }
  if (draftId === null) return null;
  // The ROW half is {@link unresolvedSendRows}, called rather than restated: the two names a row
  // is recorded under appear at different moments in one message's life, and a second reading of
  // that pair is a second chance to read only one of them.
  if (!unresolvedSendRows(lane, owner).has(draftId)) return null;
  const byRow = rows.find(
    (r) => r.draftId === draftId || lockSubjects(r).includes(`draft:${draftId}`),
  );
  return { session: byRow?.session ?? null, draftId: byRow?.draftId ?? draftId };
}

/**
 * ── THE HOLD, AS THREE ANSWERS RATHER THAN A BOOLEAN ────────────────────────────────────────
 *
 * `composeMessageHeld(parked, rowStatus) -> boolean` stood here. It carried two of the three
 * witnesses correctly and could not say the third thing a caller needs: whether it KNOWS. A
 * boolean has one place to put "no answer", and every caller put it with `false`.
 */
export type Hold =
  /** Nothing is waiting on this message. Every write site may proceed. */
  | { kind: "free" }
  /**
   * A send of this message has not been confirmed. `by` names the witness:
   *
   *  · `"record"` — the durable record this browser wrote. The only witness for a row the server
   *    still calls `draft`, and for a message with no row at all.
   *  · `"status"` — the mirror says the row is past `draft`. The only witness for a row this
   *    browser never learned the id of: a press with no row makes the ADAPTER create one, that row
   *    is what the server marks, and nothing here can name it.
   *
   * `draftId`/`session` are the identity to RESTORE — a door in between (a contact's Write, a mail
   * link) legitimately mints a new session, so a caller that only learned "yes" would present the
   * message under a session the record has never heard of: no warning, Send live, one press, a
   * second copy.
   */
  | {
      kind: "parked";
      by: "record" | "status";
      /**
       * WHAT THE MIRROR CALLS THE ROW, when `by` is `"status"` — `null` for a record park.
       *
       * Carried because one status is not like the others and a caller has to be able to tell:
       * `sent` is the server's TERMINAL CONFIRMATION, so a surface must not project it into "we
       * couldn't confirm this send". Every status past `draft` still refuses a WRITE — that is
       * invariant S(2) and it does not vary — but what the person is TOLD does.
       */
      status: string | null;
      draftId: string | null;
      session: string | null;
    }
  /**
   * NOBODY KNOWS. The jar threw on read, or the mirror cannot yet name the row this surface is
   * holding (a cold reload: the shell starts the engine in an effect and the rows arrive after).
   *
   * Not `free`. Collapsing the two is what let a private window read as "this browser has no
   * unresolved sends" and take every recovery door there is. See invariant S(4): the PRESS is
   * admitted on `unknown` (a browser that refuses storage must still send); every recovery —
   * discard, re-mint, adopt, create — fails closed.
   */
  | { kind: "unknown" };

/** The narrowest thing {@link holdOf} needs: one mirror read. Any `OhmailEngine` satisfies it. */
export interface HoldMirror {
  read(): { get<T = unknown>(type: string, id: string): T | undefined };
}

/**
 * ── IS THIS MESSAGE HELD? THE ONE PREDICATE — invariant S(4) ────────────────────────────────
 *
 * Every write site in the shell asks THIS and nothing else: the autosave create, the autosave PUT,
 * the adopt-on-mount, `openDraft`, `writeTo`, the mailto seam, `cancelCompose`, the Send press,
 * the settled discard. A census in the web application's own suite pins the per-file call-site
 * COUNT, because a census over file MEMBERSHIP cannot see a missing call.
 *
 * ── WHY IT IS ONE FUNCTION AND NOT THREE ────────────────────────────────────────────────────
 *
 * It was three — `parkedHere` in the autosave, `parkedComposeRecord` + `composeMessageHeld` at the
 * reopen, and the send gate's own reading — and each of the seven fixes before this one closed the
 * duplicate route the previous one had left. Every one of those routes was the same shape: two of
 * the three agreed that a message was held and the third wrote anyway. The write is what matters,
 * so the answer is computed in one place and the sites consume it.
 *
 * ── THE THREE ANSWERS, AND WHY `unknown` IS NOT `free` ──────────────────────────────────────
 *
 * The record is asked FIRST, because it speaks for a row the server still calls `draft` and for a
 * message with no row at all. The mirror's status is asked SECOND, because it speaks for the row
 * the adapter made for itself, whose id this browser is never told.
 *
 * `parked/status` is every status that is not `draft` — `sending`, `unverified`, `sent`. It used
 * to be `unverified` alone, so a STRANDED `sending` row (a send whose answer never arrived, its
 * record swept or never written) read as an ordinary draft: reopening it took the recovery door,
 * and one press delivered the message a second time. `sent` is in the list for the same reason and
 * costs nothing — such a row is not offered in Drafts.
 *
 * A row the mirror cannot NAME is `unknown`, never `free`. Absent and "not loaded yet" look
 * identical through `get`, and on the path this exists for — a reload — the mirror is empty at
 * mount.
 */
export function holdOf(
  engine: HoldMirror,
  q: { lane: string; draftId: string | null; session: string | null },
  owner: string | null = storageOwner(),
): Hold {
  // THE JAR FIRST. A browser that will not answer about its own records cannot be read as a
  // browser with none — see {@link load}, which is where the two used to collapse.
  if (load(owner) === null) return { kind: "unknown" };
  const record = parkedComposeRecord(q.lane, q.draftId, q.session, owner);
  if (record !== null) {
    return {
      kind: "parked", by: "record", status: null,
      draftId: record.draftId, session: record.session,
    };
  }
  /**
   * ── NO ROW IS NOT A HOLD, AND WHAT COVERS THE SEQUENCE THAT HAS NO ROW ───────────────────
   *
   * A compose that has never been saved is named by its session alone, and the record arm above is
   * the only thing in the jar that can speak for it.
   *
   * There IS a sequence with no row that needs covering — press Send before the first autosave,
   * lose the response, reload: the record this browser wrote is ORDINARY (nothing observed an
   * outcome, so nothing marked it `unverified`), and while the outbox replays that send the
   * restored surface's timer can create a second row for the same message.
   *
   * PARKING ON THAT RECORD WAS TRIED HERE AND IS WRONG, which the suite proved rather than a
   * reading: with no row the record's only name is the compose SESSION, and a genuinely new
   * message written on the same lane answers to that name too — so the park refused a message
   * nobody had ever pressed Send on ("a DIFFERENT message written after the crash gets a key of
   * its own", red). A guard that refuses the right person is the failure this file's own header
   * warns about.
   *
   * The discriminator that is exact is not in the jar at all: it is whether the durable OUTBOX
   * still holds a `mail_send` for this lane. That names the actual pending verb, cannot mistake a
   * new message for an old one, and is bounded by the queue draining rather than by a seven-day
   * TTL. It is read where the surface already reads the engine — `sendInFlight` in `AppShell.tsx`
   * — and refuses the CREATE there.
   */
  if (q.draftId === null) return { kind: "free" };
  const row = engine.read().get<{ status?: unknown }>("draft", q.draftId);
  if (row === null || row === undefined || typeof row.status !== "string") return { kind: "unknown" };
  if (row.status !== "draft") {
    return {
      kind: "parked", by: "status", status: row.status,
      draftId: q.draftId, session: q.session,
    };
  }
  return { kind: "free" };
}

/**
 * THE SERVER SAYS THIS ROW WAS SENT, SO THE RECORD ABOUT IT IS SETTLED — release it.
 *
 * The confirmed path releases a record through {@link releaseSendLock}, keyed by the fingerprint
 * the press computed. A tab that DIED holding that answer leaves the record behind with nobody to
 * release it, and the next mount reads it as a send still owed an answer. The mirror's `sent` is
 * the server's own terminal word about that row, so it settles the record the same way — by the
 * ROW, which is the only name this path has.
 */
export function releaseSendLockForRow(
  lane: string, draftId: string, session: string | null = null,
  owner: string | null = storageOwner(),
): void {
  const rows = loadOrEmpty(owner);
  // BOTH NAMES, for the reason everything else in this file reads both: the record was written at
  // one moment in the message's life and is settled at another. A press before the first autosave
  // recorded `compose:<session>` and NO row — matching on the row alone would leave exactly that
  // record behind, which is the one this path exists for.
  const names = new Set<string>([`draft:${draftId}`]);
  if (session !== null) names.add(`compose:${session}`);
  const kept = rows.filter((r) => !(
    r.lane === lane && r.v <= SEND_LOCK_FORMAT
    && (r.draftId === draftId || lockSubjects(r).some((n) => names.has(n)))
  ));
  if (kept.length !== rows.length) save(kept, owner);
}

/** `true` for every hold that is not `free` — the shape a write site's guard reads. */
export function holdRefusesWrite(hold: Hold): boolean {
  return hold.kind !== "free";
}

/**
 * ── WHICH DRAFT ROWS AN UNRESOLVED SEND ON THIS LANE BELONGS TO ─────────────────────────────
 *
 * {@link parkedComposeMessage}'s row half, and the only reading of it: both call sites in the app
 * ask the guard, the guard asks this, so the two cannot drift apart the way they did when each
 * site decided for itself. Exported on its own because a test can read a set and cannot read a
 * boolean's reasons.
 */
export function unresolvedSendRows(lane: string, owner: string | null = storageOwner()): Set<string> {
  const out = new Set<string>();
  for (const r of loadOrEmpty(owner)) {
    if (r.lane !== lane || r.unverified !== true || r.v > SEND_LOCK_FORMAT) continue;
    if (r.draftId !== null && r.draftId.length > 0) out.add(r.draftId);
    for (const s of lockSubjects(r)) if (s.startsWith("draft:")) out.add(s.slice("draft:".length));
  }
  return out;
}

/**
 * THE DRAFT ROW THIS MESSAGE HAS ACQUIRED SINCE THE KEY WAS MINTED — recorded, never re-keyed.
 *
 * A compose pressed before autosave had written anything holds `draftId: null`, and a row appears
 * moments later. The record's identity does NOT move with it — that is the whole point of
 * {@link SendLock.session}, and re-keying the subject onto the new row is exactly the defect this
 * pair of fields exists to close. What the row is worth is diagnostic: somebody reading the jar
 * beside a parked send, or the account's Drafts list, needs to know which row belongs to the
 * message whose outcome nobody knows. So it is written down and nothing branches on it.
 *
 * Matched on the SET, so it finds the record however the message is named at this moment. Only a
 * record that names this message is touched, and only when the row has actually changed.
 */
export function attachSendLockDraft(
  lane: string,
  subjects: ReadonlyArray<string>,
  draftId: string | null,
  owner: string | null = storageOwner(),
): void {
  if (subjects.length === 0 || draftId === null) return;
  const rows = loadOrEmpty(owner);
  let moved = false;
  const next = rows.map((r) => {
    if (r.lane !== lane || r.draftId === draftId) return r;
    if (!lockSubjects(r).some((s) => subjects.includes(s))) return r;
    moved = true;
    return { ...r, draftId };
  });
  if (moved) save(next, owner);
}

/**
 * Record that ONE MESSAGE's send on this lane came back unverified. See {@link SendLock.unverified}.
 *
 * Keyed by `(lane, fingerprint)` for the same reason {@link releaseSendLock} is: the lane may hold
 * more than one record, and marking "the first one for this lane" would stamp the ambiguity onto
 * whichever message happened to be listed first.
 */
export function markSendLockUnverified(lane: string, fp: string, owner: string | null = storageOwner()): void {
  const rows = loadOrEmpty(owner);
  const found = rows.find((r) => r.lane === lane && r.fp === fp);
  if (!found || found.unverified === true) return;
  save(rows.map((r) => (r === found ? { ...r, unverified: true } : r)), owner);
}
