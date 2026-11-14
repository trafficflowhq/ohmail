/**
 * A LETTER'S BODY: as the server stores and answers it, as a client reads that answer, as a device
 * copy keeps it, and what a surface is told about the text it is about to draw.
 */
import type { UnsubscribeHeaderState } from "./base.js";

/**
 * Why a stored body holds no content, when that is POLICY rather than an empty message — the
 * projection of `message_bodies.withheld_reason`, verbatim, closed set. `"storage_cap"` — the
 * account's managed storage cap (mail 0062) declined or evicted it; the mail is untouched on the
 * user's own server. `"junk_filed"` — the spam verdict filed it to the provider's native \Junk
 * (mail 0065); the sender rule is the durable artifact, the bytes live on in Junk. `"expunged"` —
 * every watched copy is gone (mail 0065); the husk stops the account paying for its bytes.
 * `"too_large"` — over the download ceiling (mail 0134): only its headers were read, never its
 * body. Absent for every ordinarily stored body, including a genuinely empty one.
 *
 * Every member hydrates as ITSELF into the mirror: narrowing unknown
 * members to `null` would persist "an ordinary, complete, empty body" —
 * answered, never re-asked — the permanent lie the tri-state ended.
 */
export type WithheldMarker = "storage_cap" | "junk_filed" | "expunged" | "too_large";

// ── Message body. The 1:1 `message_bodies` row.
// `text` is the sensitivity-REDACTED body when the message is sensitive (never an
// OTP/secret) — the API returns it as-is and NEVER re-derives a secret. ──
export interface MessageBodyDTO {
  messageId: string;
  text: string;
  html: string | null;
  headers: Record<string, unknown>;
  loadedRemoteContent: boolean;
  /**
   * What this sender's `List-Unsubscribe`/`-Post` headers offer, DERIVED server-side from the
   * raw `headers` above (which never reach the client mirror). It rides the body fetch a surface
   * already makes, so a Screener preview can say "this sender offers a way out" and, for
   * `one_click`, act on it via `POST /messages/:id/unsubscribe`. See
   * `@trafficflow/core/mail#unsubscribeHeaderState`.
   */
  unsubscribe: UnsubscribeHeaderState;
  /**
   * The sender's OWN `https:` unsubscribe page, present ONLY for `unsubscribe === "not_one_click"`
   * — a link the reader opens in their own browser when one-click is not on offer. `null`
   * otherwise: a `one_click` message is acted on by the server route (its POST token never
   * reaches the client), and `no_header`/`mailto_only` have no https link to offer.
   */
  unsubscribeUrl: string | null;
  /**
   * Why `text` is empty, when it is empty by POLICY: `"storage_cap"` means ingest declined to
   * store this body because the account was at its cap — the mail itself is untouched on the
   * user's own server. Absent for every ordinarily stored body, including a genuinely empty one,
   * so the client can tell "this message says nothing" from "we are not holding what it says" —
   * the two used to collapse into one blank pane claiming to be complete. Served AS STORED, on
   * the same no-rehydrate contract as everything else here. Mail 0065 widens the closed set — see
   * {@link WithheldMarker} for the two new members.
   */
  withheld?: WithheldMarker;
}

/**
 * One row of the batch text pull (`GET /messages/bodies`) — the foundation of the macOS
 * Cloud-local text mirror.
 *
 * A TRIMMED {@link MessageBodyDTO}: the stored `text` (already sensitivity-redacted at write
 * time) and `html` (`null` for positively-sensitive mail, dropped by the pipeline at write
 * time), both VERBATIM — this surface never re-derives a secret. There is deliberately **no
 * `headers`** field and no attachment bytes: the batch text pull carries the body and nothing
 * else, and that absence is the no-rehydrate guarantee.
 */
export interface MessageBodyBatchItem {
  messageId: string;
  text: string;
  html: string | null;
  loadedRemoteContent: boolean;
  /**
   * The sender's unsubscribe posture — `?ids=` MODE ONLY, absent in the keyset mode. The two
   * modes serve two consumers: the keyset page feeds the macOS local text mirror and joins the
   * body row and NOTHING else — that absence is its no-rehydrate guarantee, pinned by a test
   * asserting the item's exact key set. The `?ids=` page feeds a READER opening a thread, so its
   * rows carry the same derived posture the single-message route carries, or a conversation's
   * siblings would offer no way out. Optional rather than a second interface: one row shape, one
   * field the mirror mode does not populate. Raw headers cross the wire in NEITHER mode.
   */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's own https unsubscribe page, `?ids=` mode and `not_one_click` only; else null. */
  unsubscribeUrl?: string | null;
  /**
   * The stored row's withheld marker, BOTH modes — see {@link MessageBodyDTO.withheld}. In both
   * it is a fact about the ROW, projected verbatim: the mirror needs it or a withheld body is
   * mirrored as an empty complete one and never re-asked; the reader needs it for the honest
   * sentence. It extends the no-rehydrate pin rather than weakening it — a withheld row is
   * served exactly as stored, and nothing here gains a fetch.
   */
  withheld?: WithheldMarker;
}

/**
 * Why an unsubscribe was refused, mirroring the server's `UnsubscribeRefusal`. Only
 * `"already_recorded"` arrives on a 2xx {@link UnsubscribeResult}; the rest are carried by a
 * thrown `MutationRejectedError` with the server's own sentence (the same shape every refused
 * mutation takes), so a surface renders that message rather than mapping these itself.
 */
export type UnsubscribeRefusal =
  | "not_actionable"
  | "author_failed_authentication"
  | "no_header"
  | "mailto_only"
  | "not_one_click"
  | "already_recorded"
  /**
   * A record exists whose send did NOT settle as done. It arrives on a 2xx like
   * `"already_recorded"` and is emphatically NOT it: a claim is written before the request, so a
   * claim that was stranded or failed means nothing was sent. A surface may not render this one
   * as a completed unsubscribe.
   */
  | "previous_attempt_unsettled"
  /**
   * THROWN, never on a 2xx: `unsubscribe_list_refused` (the list answered and did not accept; its
   * `details.siteUrl` is the letter's https link, and the list is not asked again) and
   * `unsubscribe_list_failed` (retryable: the list could not take it, and a press may ask again).
   */
  | "list_refused"
  | "list_failed";

/**
 * What `POST /messages/:id/unsubscribe` answered on a 2xx. A refusal (409) is NOT this — it is a
 * throw carrying the server's sentence, exactly as `fetchBody`'s 402 is. So the only outcomes
 * here are a send the list accepted (`posted: true`, a 2xx `status`) and "this list was already left"
 * (`posted: false`, `refusal: "already_recorded"`), which is not a failure. Fields beyond these
 * are read leniently and unknown ones ignored (§8).
 */
export interface UnsubscribeResult {
  messageId: string;
  /** Did the server actually make the one-click request to the sender? */
  posted: boolean;
  /** The sender's HTTP status, or `null` when nothing was sent. */
  status: number | null;
  refusal: UnsubscribeRefusal | null;
  /** What the headers offered, independent of whether the server acted. */
  header: UnsubscribeHeaderState;
}

/**
 * `GET /messages/:id/body`, as much as this client reads. `html` used to be dropped here
 * (pre-sanitizer), so every surface rendered the `text/plain` alternative — a billing mail read
 * as its logo's filename; the message-body renderer (DOMPurify + a sandboxed frame fetching
 * nothing remote) answered both objections. `text` is not legacy: sensitive mail stores no
 * html, plain-text mail has none, and the sanitizer can refuse it — `text` is what all three
 * render, ALREADY redacted server-side; this client never re-derives or second-guesses a
 * redaction. `headers` stays deliberately unread (§8: an unread field is not an error).
 */
export interface MessageBodyWire {
  text: string;
  /**
   * The stored `text/html` part, or `null`. NEVER rendered as-is by anything: it is
   * attacker-authored markup, and the one component allowed to touch it sanitizes it first.
   * It may also be TRUNCATED mid-tag — `prepareHtmlForStorage` cuts at 256 KiB and appends
   * an html comment — which is why the renderer must go through a parser that repairs, and
   * not a string transform.
   */
  html: string | null;
  /**
   * Whether the reader has already said yes to remote content for this message
   * (`message_bodies.loaded_remote_content`, flipped by `POST /messages/:id/load-remote`).
   * `false` is the default and the state every message starts in.
   */
  loadedRemoteContent: boolean;
  /**
   * The sender's unsubscribe posture, DERIVED server-side from the raw headers (which the client
   * never receives). Absent on an older server → the reader defaults it to `"no_header"` (§8).
   */
  unsubscribe: UnsubscribeHeaderState;
  /**
   * The sender's own https unsubscribe page, sent ONLY for `unsubscribe === "not_one_click"`;
   * `null` otherwise. Never a one-click POST token (the server owns that). Absent on an older
   * server → `null` (§8).
   */
  unsubscribeUrl: string | null;
  /**
   * The server's word for why `text` is empty, when it is empty by POLICY — the closed
   * {@link WithheldMarker} set. In every case the mail itself is untouched on the user's own
   * mail server (for `junk_filed` it lives in the provider's Junk folder, where the verdict
   * sent it). Absent on every ordinarily stored body and on an older server (§8). See
   * {@link MessageBodyRecord.withheld} for how the engine carries it and {@link BodyState} for
   * the terminal surface state it becomes.
   */
  withheld?: WithheldMarker;
}

/**
 * One row of the batch body read — `GET /messages/bodies?ids=…`, the
 * thread-open call. Exactly a {@link MessageBodyWire} plus the id it
 * answers for: both routes serve the same stored row and there must be no
 * second shape for a body. The id is on the ROW, not positional: the server
 * answers only ids it owns — a cross-account or vanished id is silently
 * absent, never a null placeholder or an error, so the response cannot be
 * an existence oracle for another account's ids; callers match on this field.
 */
export interface MessageBodyBatchWire extends MessageBodyWire {
  messageId: string;
}

/**
 * The hydrated body as a client-local record — and why it is not on the message. `message_body`
 * is in {@link MirrorEntityType} and deliberately NOT in {@link SyncEntityType}: `/sync` has no
 * such type, so no delta can ever overwrite one. Writing the text onto the `message` row would
 * break invisibly: `applyToRecords` REPLACES the entity on update, and opening a message emits
 * `mark_seen`, whose echo carries a DTO with `snippet` and no body — the body would be wiped by
 * the read-receipt of reading it. `state` is stored, not derived: "asked and refused" must be
 * distinguishable from "never asked" — see {@link BodyState}.
 */
export interface MessageBodyRecord {
  messageId: string;
  state: "loading" | "ready" | "failed";
  /** The endpoint's already-redacted text. Empty while loading and after a failure. */
  text: string;
  /**
   * The server's word for why a `ready` record's text is empty: `"storage_cap"` means ingest
   * declined to store the body (the mail is untouched in the mailbox). Answered-terminal: never
   * `failed` (Retry cannot un-withhold), not re-asked until its message changes (the store sheds
   * it then: the server may have given the text back). Tri-state like `html`: `"storage_cap"`
   * = withheld; `null` = answered by a withheld-aware build, ordinarily stored; `undefined` =
   * no aware build ever answered — a pre-slice tab could persist `{state:"ready", text:""}` for
   * a withheld body, a permanent lie nothing could heal. Both write sites normalize
   * (`fetchBodyInto`, `fetchBodiesInto`); the WIRE type stays two-state.
   */
  withheld?: WithheldMarker | null;
  /**
   * Set on a `storage_cap` record by a build that sheds it on its message's change, the signal the
   * storage refill gives. A `storage_cap` record without it was written by an older build, which kept
   * it through such a change, so it is asked once more.
   */
  capRefill?: true;
  /**
   * The endpoint's html part, or `null` — none, sensitive mail, or a record that is not
   * `ready`. Held off the message row so a `/sync` delta cannot erase it. Optional because of
   * IndexedDB, not mail: persisted records from before `html` was read lack the key and must
   * not be migrated (an invented `html: null` is indistinguishable from a message with none).
   * `undefined` is load-bearing: "no build ever answered", and `hydrateBody` re-asks exactly
   * once; `null` means "asked — no html" and must NOT re-ask. Never write `undefined` from new
   * code: `fetchBodyInto` normalises with `?? null`, which terminates the re-fetch.
   */
  html?: string | null;
  /** The reader's remote-content decision, as the server last stated it. Optional for the
   *  same reason `html` is: a record written before those fields were read carries neither. */
  loadedRemoteContent?: boolean;
  /**
   * The sender's unsubscribe posture on this hydrated body. Optional for the same reason `html`
   * is: a record persisted before this field was read carries neither, and `bodyOf` reads it with
   * `?? "no_header"`. `null`/absent on every non-`ready` record. */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `unsubscribe === "not_one_click"` only; else null. */
  unsubscribeUrl?: string | null;
  /** Why the fetch failed, for the console — never rendered to the user. */
  error?: string;
  /**
   * When the fetch failed, epoch ms — what makes a failure survivable
   * across a reload. `hydrateBody` does not re-ask a `failed` record on an
   * automatic trigger inside `FAILED_BODY_HOLD_MS` (an effect re-firing per
   * mirror bump would poll a refusing server); the records are PERSISTED, so "never re-ask" was
   * silently for ever: one 500 stayed failed until Retry on that message.
   * Narrowed to the session that asked: a `failedAt` before this engine's
   * boot is re-asked exactly once on the next explicit intent. Absent means
 * stale (older builds wrote none) and heals; the engine remembers healed ids in memory this session.
   */
  failedAt?: number;
}

/**
 * What a surface knows about the text it is about to render — in the type,
 * because `body ?? snippet` shipped a one-line truncation as the message:
 *  · `full`     — the whole message; clamp, offer the pill, say nothing.
 *  · `snippet`  — a preview; the body was never asked for. Offer the pill.
 *  · `loading`  — asked, in flight. Say so.  · `failed`   — asked, refused. Say so, differently.
 *  · `withheld` — asked, ANSWERED: no stored body (storage cap). Terminal —
 *    no Retry, no spinner, the honest sentence; the mail itself is still in
 *    the mailbox on the user's own server.
 */
export type BodyState = "full" | "snippet" | "loading" | "failed" | "withheld";

/**
 * The body to render plus what it actually is — see {@link BodyState}.
 * `html` is a second rendition, never a replacement for `text`: a surface
 * picks html when it has a renderer and falls back to `text`; surfaces that
 * cannot render html (clamped previews, the Screener's consent preview,
 * notifications) keep reading `text` unaffected. `html` is non-null ONLY
 * when `state === "full"`: a snippet is not html, and neither `loading` nor
 * `failed` has a body to describe.
 */
export interface MessageBody {
  /**
   * Present ONLY on the `withheld` state: WHICH policy emptied the stored body, so a surface
   * can say the right sentence for each ({@link WithheldMarker}). Absent everywhere else.
   */
  withheld?: WithheldMarker | null;
  text: string;
  state: BodyState;
  /** The sender's html part, unsanitized. `null` unless `state === "full"`. */
  html: string | null;
  /** Whether the reader has consented to remote content for this message. */
  loadedRemoteContent: boolean;
  /**
   * The sender's unsubscribe posture. `"no_header"` for every state but `full` (nothing to say
   * before the body is hydrated), and the honest default for an older server. A surface offers an
   * action only for `one_click` / `not_one_click`.
   */
  unsubscribe: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `not_one_click` only; `null` otherwise. */
  unsubscribeUrl: string | null;
}
