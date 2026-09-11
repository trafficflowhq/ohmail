/**
 * Composing a new message — the three fields, and the address parser. A reply inherits recipient,
 * subject, mailbox and thread from the message being answered; a compose has none of that, so this
 * module owns turning a line of typed text into recipients, and refusing to guess. It deliberately
 * knows nothing about React and nothing about send phases — `mail-send.ts` owns the state machine
 * and `canSend` — so the parsing is testable one row at a time and cannot drift into a second copy
 * of the send rule.
 */
import type { ComposeAttachment, EmailAddress, EngineMutation } from "@ohmail/client-engine";
import type { SignatureState } from "./signature";
import { durableRemove, durableSet } from "./durable";
import { storageOwner } from "./storage-owner";

/** The compose form, verbatim as typed. `to` is TEXT; `plan()` is what turns it into addresses. */
export interface ComposeFields {
  to: string;
  /**
   * Carbon and blind-carbon recipients, each ONE comma-separated string exactly like {@link to}.
   *
   * They are the same shape as `to` on purpose: the same `RecipientField` combobox drives all
   * three, the same `parseRecipients` splits them, and the same "a typo blocks the whole send"
   * rule applies (`composePlan`). A `Cc` recipient is a visible header on the delivered mail; a
   * `Bcc` recipient is delivered on the SMTP envelope and NEVER written into the headers — the
   * asymmetry is enforced at the MIME builder (`imap.ts#send`), not here, so this form only has to
   * carry two more lines of text.
   */
  cc: string;
  bcc: string;
  subject: string;
  /**
   * The message as PLAIN TEXT — the editor's own rendering when {@link html} is set.
   *
   * It stays the field every local check reads: `canSend` refuses an empty one, the optimistic
   * draft row shows it, and `writeComposeDraft` decides on it whether there is a draft to keep
   * at all. It is deliberately NOT what a plaintext recipient reads — the server derives that
   * from the sanitized markup so the two halves of a `multipart/alternative` cannot be made to
   * disagree by a client (`outbound-html.ts`).
   */
  body: string;
  /**
   * The markup, or `""` for a message with no formatting in it.
   *
   * A SECOND FIELD rather than a `RichValue` in `body`, and rather than the envelope
   * `rich-text.ts` writes: this buffer is already a JSON object, so an envelope inside it would
   * be a second encoding to keep true for nothing. The reply key needs one because it holds a
   * bare string; this one does not. It is read field-wise below, exactly like `fromMailboxId`,
   * so a buffer written before this field existed still restores as a plain draft.
   */
  html: string;
  /**
   * The sender the user picked, as a mailbox id; `null` = they did not pick one. A field on the
   * FORM rather than a derivation, because a default re-derived on every render would silently
   * revert a deliberate choice — `drafts.mailboxId` is NOT NULL and immutable after create, so the
   * pick must survive as long as the text it belongs to; it lives beside the body so leaving the
   * view throws away neither. `null` is not "no mailbox": the derived default applies. A stored id
   * is revalidated against the account's mailboxes on the way out (`resolveComposeFrom`), never
   * trusted. Never an address string — see `compose-from.ts`.
   */
  fromMailboxId: string | null;
  /**
   * Files to send with this message — held in memory only, never written to `localStorage`.
   * Attachments carry base64 bytes and a photo would blow past a quota Safari private mode refuses
   * outright, so `writeComposeDraft` strips this field and `readComposeDraft` never restores it: the
   * buffer's job is to survive navigation and a reload of the TEXT, and a file picked before a
   * reload is re-picked — honest, rather than a phantom paperclip pointing at bytes that are gone.
   * Not part of the autosaved `drafts` row either — nothing on the account stores attachment bytes
   * (§13.2/§14) — so `signatureOf`/`worthSaving` ignore it. Optional, so an old buffer reads back
   * as a draft with no files.
   */
  attachments?: ComposeAttachment[];
  /**
   * The message this compose is forwarding — an id, and nothing else. A forward is written on the ordinary compose
   * form; this one field turns it into a forward on the wire, and it deliberately carries no copy of the original —
   * not body, attachments or quote. The SERVER reads the original from the account, refuses a `no_forward` one,
   * builds the quote and streams the attachments from IMAP at send (`send-service.ts`); a client-assembled quote is
   * exactly the seam a redacted sensitive body would escape through. PERSISTED in the scratch buffer, unlike {@link
   * attachments}: one short string, and a reload that silently turned the message back into a plain compose would
   * send an empty mail with "Fwd:" on it. Guarded field-wise on read, like {@link fromMailboxId}. `null` is the
   * ordinary case; the exclusive peer of `inReplyTo` — a forward threads onto no conversation (`types.ts`).
   */
  forwardOf?: string | null;
  /**
   * THE SIGNATURE BLOCK'S STATE for this message — follows the From selector until the user
   * removes or edits it, and then their choice wins (`signature.ts` owns the model and the
   * serialization). Absent means `following`, which is what every buffer written before the
   * field existed restores as. It lives on the FORM because a removal belongs to the message
   * being written: leaving the view and coming back must not resurrect a struck block, and a
   * reload restores it with the text it belongs to.
   */
  sig?: SignatureState;
}

export const EMPTY_COMPOSE: ComposeFields = {
  to: "", cc: "", bcc: "", subject: "", body: "", html: "", fromMailboxId: null, attachments: [],
  forwardOf: null,
};

/**
 * A compose handed to the shell from OUTSIDE — the shape a host passes when the operating
 * system delivered it a `mailto:` click (`AppShell`'s `mailtoDraft` prop; the desktop's
 * `mailto.ts` is the one parser that produces it).
 *
 * Recipients are ARRAYS of plain addresses here, unlike {@link ComposeFields}' comma-separated
 * text, because the producer has already split them and the seeder formats them into chips —
 * handing a pre-joined string across the seam would mean two places knowing the separator
 * convention. The body is PLAIN text; the seeder sets `html: ""`, `openDraft`'s rule.
 */
export interface ComposePrefill {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/**
 * `localStorage` key for the compose scratch buffer — one per ACCOUNT, not one per browser. The bare constant
 * was true about the surface and wrong about the storage: nothing cleared the key on sign-out
 * (`clearBootCaches()` removes only `ohmail.boot.`, `clearAllMirrors()` is IndexedDB), so one account's
 * unfinished message survived into the next account on the same browser, where autosave could persist it as
 * THEIR server draft. The suffix is `searchSortKey`'s shape, with the same `"local"` fallback. The owner is
 * `storageOwner()`, not `readOwner()`: the standalone desktop has no cookie, so this key used to resolve to
 * `"local"` for every mailbox on the install at once — and the desktop mounts an engine per mailbox. The legacy
 * key is drained, never read "to migrate": the migrating reader has no way to know whose draft it is.
 */
/** Every owner's scratch key starts here. Exported so sign-out can sweep them. */
export const COMPOSE_DRAFT_PREFIX = "ohmail.ui.compose.";

export function composeDraftKey(owner: string | null = storageOwner()): string {
  return `${COMPOSE_DRAFT_PREFIX}${owner ?? "local"}`;
}

/** The un-owned key this browser may still hold. Removed on clear, never read. */
export const LEGACY_COMPOSE_DRAFT_KEY = "ohmail.ui.compose";

/**
 * The scratch buffer, and what it is NOT. This is the client's own draft, in this browser, exactly like the
 * per-message reply buffer. It is not an IMAP draft and it is not a `drafts` row on the server: nothing is written to
 * the account until Send is pressed, because a draft-per-keystroke is a write storm and an orphan-row factory (`POST
 * /drafts` has no delete-on-abandon path the client drives). Server drafts on the mailbox are a later phase, and when
 * they arrive they belong on the mailbox itself; the compose surface therefore says "kept in this browser" and
 * nothing stronger. Storage can refuse — Safari private mode throws on write — and a refusal must never break
 * composing, so every access is wrapped and a failure simply means the draft lives for as long as the tab does.
 */
export function readComposeDraft(): ComposeFields {
  try {
    const raw = window.localStorage.getItem(composeDraftKey());
    if (!raw) return EMPTY_COMPOSE;
    const parsed = JSON.parse(raw) as Partial<ComposeFields>;
    return {
      to: typeof parsed.to === "string" ? parsed.to : "",
      // Guarded field-wise like every other line here, so a buffer written before Cc/Bcc existed
      // restores as a draft with empty Cc/Bcc rather than throwing or dropping the whole draft.
      cc: typeof parsed.cc === "string" ? parsed.cc : "",
      bcc: typeof parsed.bcc === "string" ? parsed.bcc : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      // Same field-wise guard as `fromMailboxId` below, and it is what makes a draft written
      // by the plain textarea restore as a plain draft rather than as an empty one.
      html: typeof parsed.html === "string" ? parsed.html : "",
      // Guarded field-wise, so a buffer written before this field existed reads back as "no
      // pick" and one
      // written after it is still readable by a bundle that predates the field. Nothing here
      // versions the shape, and nothing needs to.
      fromMailboxId: typeof parsed.fromMailboxId === "string" && parsed.fromMailboxId.length > 0
        ? parsed.fromMailboxId
        : null,
      // NEVER restored — bytes are transient and are stripped on write. A restored draft starts
      // with no files, and a file the user had picked before reloading is re-picked.
      attachments: [],
      // RESTORED, because it is an id rather than bytes and losing it would turn a half-written
      // forward back into an empty message titled "Fwd: …". Guarded field-wise like
      // `fromMailboxId`: a buffer written before this field existed reads back as a plain compose.
      forwardOf: typeof parsed.forwardOf === "string" && parsed.forwardOf.length > 0
        ? parsed.forwardOf
        : null,
      // Guarded field-wise like its neighbours: only the three shapes the model names restore,
      // and anything else — a buffer from before the field, or a value some other version wrote
      // — reads back as `following`, which is the resting state.
      ...(parsed.sig?.kind === "removed" ? { sig: { kind: "removed" as const } }
        : parsed.sig?.kind === "edited" && typeof parsed.sig.text === "string"
          ? { sig: { kind: "edited" as const, text: parsed.sig.text } }
          : {}),
    };
  } catch {
    // Blocked storage, or a value some earlier version wrote in another shape. Either way an
    // empty form beats throwing inside a render.
    return EMPTY_COMPOSE;
  }
}

/**
 * THE SCRATCH BUFFER, THROUGH THE CHECKED WRITE — `durable.ts`.
 *
 * A refused jar loses what somebody has written, which is the same fact about the browser as a
 * lost decision, so it raises the same notice. Nothing else changes here: there is no undo window
 * over a compose to degrade, and the draft still lives in React state for the length of the tab.
 */
export function writeComposeDraft(f: ComposeFields): void {
  /**
   * "EMPTY" IS ABOUT THE TEXT, and `fromMailboxId` deliberately does not count. A sender pick on a form with nothing
   * written in it is not a draft — persisting it would turn every visit to Compose into a stored buffer, and it would
   * make the pick sticky in a way ruling 2 rules out: the default is derived on every fresh compose, and the only
   * thing worth remembering is a pick attached to a message somebody is actually writing. `html` does not count
   * either, and for a sharper reason: an empty ProseMirror document serialises to `<p></p>`, so testing it would make
   * every visit to Compose leave a stored buffer behind. `body` is the editor's plain rendering and is `""` for that
   * document, which is why it is the field that decides. Same rule as `isRichEmpty`.
   */
  if (f.to === "" && f.cc === "" && f.bcc === "" && f.subject === "" && f.body === "") {
    durableRemove(composeDraftKey(), "compose.draft");
    return;
  }
  // STRIP THE ATTACHMENTS' BYTES. They are held in memory only (see `ComposeFields.attachments`):
  // a photo's worth of base64 would blow a storage quota, and a restored buffer must not claim a
  // paperclip pointing at bytes it no longer holds. Everything textual is persisted as before.
  const { attachments: _drop, ...persisted } = f;
  durableSet(composeDraftKey(), JSON.stringify(persisted), "compose.draft");
}

/**
 * Which message-in-progress this compose surface is holding. There is one compose lane for
 * every message this browser will ever write, so a lane is not an identity; a DRAFT ROW is,
 * once one exists — and a new message has no row until autosave gives it one, which is exactly
 * the window `send-lock.ts` needs an identity in: a send whose outcome the server could not
 * confirm has to keep blocking THAT message and nothing else. The fingerprint cannot be it (the
 * person may edit and it is still the same message), so the identity is a session id minted
 * beside the scratch draft and cleared with it — surviving typing and reload, gone when the
 * compose is delivered or abandoned.
 */

/**
 * One session is one message, which means every door re-mints it. "Delivered or abandoned" was not the whole list: a
 * door that REPLACES the form with a different message — opening a draft, the contact popover's Write, an OS
 * `mailto:` — left the id alone, so one session spanned several messages and a record parking the first parked
 * whatever replaced it: "We couldn't confirm this send" over a message never sent, with Send refused. So {@link
 * clearComposeDraft} runs at every such door, immediately before the new form is persisted: it drops buffer and id
 * together, and the next read of {@link composeSessionId} mints fresh — the lazy read is what makes "one door, one
 * line" enough. The account's row for the replaced message goes with it ({@link composeRowKey}), the other half of
 * the same identity.
 */

/**
 * Owner-keyed and wrapped like every door in this file: a blocked jar answers `null`, which callers must read as
 * "this browser cannot name the message", never as "a new one".
 */
export const COMPOSE_SESSION_PREFIX = "ohmail.compose.session.";

export function composeSessionKey(owner: string | null = storageOwner()): string {
  return `${COMPOSE_SESSION_PREFIX}${owner ?? "local"}`;
}

export function composeSessionId(owner: string | null = storageOwner()): string | null {
  try {
    const held = window.localStorage.getItem(composeSessionKey(owner));
    if (held !== null && held.length > 0) return held;
    const minted = crypto.randomUUID();
    // A MINT NOBODY COULD STORE IS NOT AN IDENTITY. `null` here is the same answer a refused READ
    // gives — "this browser cannot name the message" — because a session id held only in this
    // call frame names nothing on the next reload. The refusal now also reaches the shell.
    return durableSet(composeSessionKey(owner), minted, "compose.session") === "stored"
      ? minted
      : null;
  } catch {
    return null; // private mode, or a full quota — see the header on what `null` means
  }
}

/**
 * PUT A MESSAGE'S OWN SESSION BACK — the one writer, and it exists for exactly one caller. Every other door MINTS
 * (lazily, by reading) or CLEARS. Reopening a message this browser holds an unresolved send record for does neither:
 * that message already HAS a session — the one the record was written under — and the surface may have minted a
 * different one since, because any door in between (writing to a contact, an operating-system mail link) legitimately
 * starts a new message. Coming back to the unconfirmed one has to come back to its identity, or the record names
 * neither of the things the message is now called and the hold silently lifts. `null` is not accepted: clearing is
 * {@link clearComposeDraft}'s job, which drops the buffer and the row with it. This only ever restores a session that
 * a record still names.
 */
export function writeComposeSession(session: string, owner: string | null = storageOwner()): void {
  // The same failure `composeSessionId` answers `null` for, and it is announced the same way.
  durableSet(composeSessionKey(owner), session, "compose.session");
}

/**
 * THE DRAFT ROW THE COMPOSE SURFACE IS HOLDING, ACROSS A RELOAD: `useComposeAutosave` keeps the row in React state,
 * and React state does not survive a reload — while the scratch buffer, which holds the TEXT of the same message,
 * does. So a reload restored the message and lost its row: the next pause created a SECOND row for it, and the
 * durable send record still named the first. One message under two rows is how a send whose outcome nobody could
 * confirm read as two messages and unlocked Send for the one that may already have gone. The row is written here
 * rather than into the buffer because it is not part of the form: it is a fact about which message the surface is
 * holding, with the same lifetime as {@link composeSessionId} — and it is cleared by the same call, at the same
 * doors, for the same reason. `null` clears it.
 */

/**
 * A blocked jar answers `null` on read, which the hook reads as "no row to adopt", never as "there is no row".
 */
export const COMPOSE_ROW_PREFIX = "ohmail.compose.row.";

export function composeRowKey(owner: string | null = storageOwner()): string {
  return `${COMPOSE_ROW_PREFIX}${owner ?? "local"}`;
}

/**
 * THE TAB'S OWN MEMORY OF THE ROW, for a browser that refuses this app its storage. There nothing can be written, so
 * `readComposeRow` answered `null` BY CONSTRUCTION: `holdOf` said `unknown`, the adoption waited, and the timer
 * created a SECOND row for the one just opened. Keyed by the same storage key, so it is account-scoped as the jar is,
 * and swept by {@link forgetComposeRows} at sign-out — an id on the departed account must not reach the next sign-in.
 * It answers ONLY when the jar throws: a jar that works and says `null` is another tab having cleared the row, and a
 * remembered value would resurrect it.
 */
const composeRowInMemory = new Map<string, string>();

/** Forget every remembered row — the sign-out sweep's half of {@link COMPOSE_ROW_PREFIX}. */
export function forgetComposeRows(): void {
  composeRowInMemory.clear();
}

export function readComposeRow(owner: string | null = storageOwner()): string | null {
  try {
    const held = window.localStorage.getItem(composeRowKey(owner));
    return held !== null && held.length > 0 ? held : null;
  } catch {
    return composeRowInMemory.get(composeRowKey(owner)) ?? null;
  }
}

export function writeComposeRow(id: string | null, owner: string | null = storageOwner()): void {
  const key = composeRowKey(owner);
  if (id === null) composeRowInMemory.delete(key);
  else composeRowInMemory.set(key, id);
  // The row stays as durable as the tab through `composeRowInMemory` above, which is why a
  // refusal is survivable here at all; it is no longer silent about being a tab's memory.
  if (id === null) durableRemove(key, "compose.row");
  else durableSet(key, id, "compose.row");
}

export function clearComposeDraft(owner: string | null = storageOwner()): void {
  // FIRST, because the remembered row must not survive a clear of the message it names.
  composeRowInMemory.delete(composeRowKey(owner));
  /*
   * FOUR INDEPENDENT REMOVALS, not one try block. Under a shared `try` the first refusal skipped
   * every line below it, so a quota that rejected the buffer's removal left the session id and
   * the row behind — the identity of a message this call has just declared over. Each door
   * answers for itself now, exactly as the sign-out sweep's per-key catch does.
   */
  durableRemove(composeDraftKey(owner), "compose.draft");
  // The session id goes with the buffer it names: the message-in-progress is over, so the next
  // press is a new message and must not inherit this one's identity.
  durableRemove(composeSessionKey(owner), "compose.session");
  // AND the row that message had on the account — the other half of the identity, and the half
  // a reload used to lose on its own. See `composeRowKey`.
  durableRemove(composeRowKey(owner), "compose.row");
  // AND the un-owned key a browser upgraded from an earlier bundle may still hold. This is
  // the only line that touches it: it is drained on the next clear and never read back.
  durableRemove(LEGACY_COMPOSE_DRAFT_KEY, "compose.draft");
}

/**
 * IS THIS AN ADDRESS? — checked HERE, before Send lights up, and not by the SMTP server. "An SMTP rejection after the
 * fact is a bad way to learn about a typo": the send path is two requests and a reservation, and a 550 arrives as
 * `unverified` — the one outcome the product cannot resolve for the user. A local check costs nothing and turns "we
 * couldn't confirm this send" back into "that address has no dot in it". CONSERVATIVE ON PURPOSE: The rule is not RFC
 * 5322 and does not try to be — the grammar admits quoted local parts, comments and bare IP-literal domains, and a
 * validator that implemented it would reject nothing anyone types by hand while adding a page of code. What it DOES
 * do is refuse the four things a human actually mistypes: no `@`, two `@`, no dot in the domain, and a stray space.
 */

/**
 * Anything past that is the server's business, which is where a genuinely exotic but legal address is still accepted
 * — this gate only decides whether Send is offered. It must never reject a valid ordinary address, so `+` tags, dots,
 * dashes, apostrophes and underscores in the local part all pass, and so do multi-label domains and long TLDs.
 */
export function isEmailAddress(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0 || s.length > 254) return false;
  if (/[\s<>,;"()[\]\\]/.test(s)) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[a-z0-9-]+$/i.test(label)) return false;
  }
  // A TLD is letters. `user@host.1` is a typo every time, and an IP-literal domain would need
  // the bracket form this parser refuses above.
  return /^[a-z]{2,}$/i.test(labels[labels.length - 1]!);
}

export interface RecipientParse {
  /** Everything that parsed, in the order typed, de-duplicated by address. */
  addresses: EmailAddress[];
  /** Entries that did not parse, verbatim, for the error line under the field. */
  invalid: string[];
}

/**
 * One line of typed text → recipients. Commas and semicolons both separate, because every mail client accepts both
 * and a user who pastes a list from elsewhere has no idea which one they got. `Name <addr>` is accepted because that
 * is what copying a recipient out of another client yields; the display name is kept, so the person's name survives
 * into `drafts.to` and out onto the wire's To header. De-duplicated case-insensitively on the address: a list pasted
 * twice must not mail anyone twice, and the SMTP envelope is built straight from this array (`SendService` →
 * `to.map(a => a.address)`).
 */
export function parseRecipients(raw: string): RecipientParse {
  const addresses: EmailAddress[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(/[,;]/)) {
    const entry = part.trim();
    if (entry === "") continue;
    const angled = /^(.*?)<([^<>]*)>$/.exec(entry);
    const address = (angled ? angled[2]! : entry).trim();
    const name = angled ? angled[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
    if (!isEmailAddress(address)) {
      invalid.push(entry);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ name: name === "" ? null : name, address });
  }

  return { addresses, invalid };
}

export type MailSend = Extract<EngineMutation, { kind: "mail_send" }>;

export interface ComposePlan extends RecipientParse {
  /** The mutation as it would go out right now. `canSend` judges THIS. */
  mutation: MailSend;
  /** True when the subject is blank — a warning on screen, never a refusal. See below. */
  noSubject: boolean;
  /**
   * The Cc and Bcc parses, each their own {@link RecipientParse}. The `to` parse is the spread
   * `addresses`/`invalid` above (backwards-compatible — `plan.invalid` still means the To field);
   * these two are named so `ComposeView` can draw a per-field error line and run the same
   * still-typing gate the To field has, without re-parsing.
   */
  cc: RecipientParse;
  bcc: RecipientParse;
}

/**
 * The compose form as a send, or as the reason it is not one yet. A typo blocks the WHOLE send,
 * it does not silently drop one recipient: `to` is `[]` whenever anything failed to parse, even
 * if three of four entries were fine. That is the load-bearing line — the refusal is expressed
 * in the MUTATION rather than as a second predicate beside `canSend`, so every caller (the
 * button's `disabled`, the state machine's guard, a keyboard shortcut, a future Reply Run) is
 * stopped by the same rule. Dropping the bad entry and mailing the rest would be the worst
 * option: the user would learn about the typo from the person who never answered.
 */

/**
 * An empty subject sends — no block, no confirm dialog: a subjectless message is legitimate mail, and a modal is the
 * exact shape Compose was moved away from. `noSubject` is surfaced as a factual note in the send row BEFORE the
 * press, the same warning arriving early enough to be useful. `mailboxId` is omitted rather than nulled when nothing
 * can name one, so `canSend` refuses and `Engine.enrich` has nothing to disagree with. And it is HANDED the answer,
 * it does not choose: `mailboxId` is `resolveComposeFrom(...).mailboxId` — the user's revalidated pick or the derived
 * default — resolved by the caller so the id on the wire is the same object the From line rendered. Passing
 * `fields.fromMailboxId` straight through would be the bug this resolution removes wearing a different hat: a
 * days-old pick against a since-disconnected mailbox would go out and collect a 409 nobody could act on.
 */
/**
 * @param draftId THE ROW THIS MESSAGE ALREADY IS, when autosave has written one. It goes on the
 * mutation so the send uses that row instead of creating a second — one draft from the first
 * keystroke to delivery. Absent for any caller that does not autosave (a test, a surface without
 * an engine), which is exactly the behaviour this had before autosave existed.
 */
export function composePlan(
  fields: ComposeFields, mailboxId: string | null, draftId?: string | null,
): ComposePlan {
  const parsed = parseRecipients(fields.to);
  // `?? ""` because `composePlan` is called directly by tests with a bare `{to,subject,body,html}`
  // form, and by a scratch buffer written before these fields existed — both reach here with `cc`
  // and `bcc` undefined, which is an empty field, not an error.
  const cc = parseRecipients(fields.cc ?? "");
  const bcc = parseRecipients(fields.bcc ?? "");
  // A typo in ANY of the three fields blocks the whole send — the same rule the To field already
  // enforces, widened to Cc and Bcc. It is expressed by emptying the recipient set the mutation
  // carries, so `canSend` (which reads `mutation.to`) refuses with no second predicate, and a bad
  // Cc address can no more "send the valid ones" than a bad To address can.
  const anyInvalid = parsed.invalid.length + cc.invalid.length + bcc.invalid.length > 0;
  return {
    ...parsed,
    cc,
    bcc,
    noSubject: fields.subject.trim().length === 0,
    mutation: {
      kind: "mail_send",
      // THE COMPOSE FORK. Null is not a default here — it is what keeps `In-Reply-To` and
      // `References` off a message that is not answering anyone (see `types.ts`).
      inReplyTo: null,
      body: fields.body,
      // ONE OR THE OTHER ON THE WIRE, and the adapter is what enforces it: `html` present
      // means `POST /drafts` carries the markup and no `body` at all, because a client that
      // supplied its own plain part would be asserting what plaintext readers see. Omitted
      // rather than sent as `""` so a plain compose produces the same request it always did.
      ...(fields.html ? { html: fields.html } : {}),
      subject: fields.subject,
      // When anything is unparseable the mutation carries NO recipients at all — not the valid
      // subset — so a half-typed or mistyped address cannot leave a partial send on the wire.
      to: anyInvalid ? [] : parsed.addresses,
      cc: anyInvalid ? [] : cc.addresses,
      bcc: anyInvalid ? [] : bcc.addresses,
      // Files ride the send request, not the draft — carried straight onto the mutation so the
      // adapter puts them on `POST /drafts/:id/send`. Omitted when there are none, so a plain send
      // builds the exact request it always did. The caller hands this function the whole form, so
      // the files reach the wire without any other call site changing.
      ...(fields.attachments && fields.attachments.length ? { attachments: fields.attachments } : {}),
      // THE FORWARD FORK, and it is the peer of the `inReplyTo: null` above rather than a second
      // way of saying the same thing: this message quotes the original and carries its attachments,
      // but it threads onto nothing and carries no `In-Reply-To`. Omitted — not sent as `null` —
      // when there is nothing to forward, so a plain compose builds the identical request it always
      // did and the http adapter's `if (m.forwardOf)` sees no key at all.
      ...(fields.forwardOf ? { forwardOf: fields.forwardOf } : {}),
      ...(mailboxId ? { mailboxId } : {}),
      ...(draftId ? { draftId } : {}),
      threadId: null,
    },
  };
}
