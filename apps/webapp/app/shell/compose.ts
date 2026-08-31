/**
 * COMPOSING A NEW MESSAGE — the three fields, and the address parser.
 *
 * A reply inherits its recipient, its subject, its mailbox and its thread from the message
 * being answered. A compose has none of that, so this module owns the part of the send that
 * a reply never needed: turning a line of typed text into recipients, and refusing to guess.
 *
 * It deliberately knows nothing about React and nothing about send phases — `mail-send.ts`
 * owns the state machine and `canSend` — so the parsing below is testable one row at a time
 * and cannot drift into a second copy of the send rule.
 */
import type { ComposeAttachment, EmailAddress, EngineMutation } from "@ohmail/client-engine";
import type { SignatureState } from "./signature";
import { readOwner } from "./owner-cookie";

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
   * THE SENDER THE USER PICKED, as a mailbox id. `null` = they did not pick one.
   *
   * It is a field on the FORM rather than a derivation because a default that is re-derived on
   * every render would silently revert a deliberate choice: `drafts.mailboxId` is NOT NULL and
   * immutable after create, so the pick has to survive as long as the text it belongs to. It
   * lives here, beside the body, for the same reason the body lives here — leaving the view and
   * coming back must not throw either of them away.
   *
   * `null` is not "no mailbox". It means the derived default applies, which is what a compose
   * nobody has touched should send from. A stored id is revalidated against the account's
   * mailboxes on the way out (`resolveComposeFrom`), never trusted.
   *
   * NEVER an address string — see `compose-from.ts`.
   */
  fromMailboxId: string | null;
  /**
   * FILES TO SEND WITH THIS MESSAGE — held in memory only, NEVER written to `localStorage`.
   *
   * Attachments carry bytes (base64), and the scratch buffer is a small string in this browser; a
   * file the size of a photo would blow past a storage quota that Safari private mode refuses
   * outright. So `writeComposeDraft` strips this field and `readComposeDraft` never restores it —
   * the buffer's job is to survive navigation and a reload of the TEXT, and a file the user picked
   * before reloading is re-picked, which is the honest behaviour rather than a phantom paperclip
   * pointing at bytes that are gone. It is also NOT part of the autosaved `drafts` row — nothing on
   * the account stores attachment bytes (§13.2/§14) — so `signatureOf`/`worthSaving` ignore it too.
   * Optional so a buffer written before it existed reads back as a draft with no files.
   */
  attachments?: ComposeAttachment[];
  /**
   * THE MESSAGE THIS COMPOSE IS FORWARDING — an id, and nothing else.
   *
   * A forward is written on the ordinary compose form: the user picks recipients and may add a line
   * above the quote, so everything the form already holds is what a forward needs. This one extra
   * field is what turns it into a forward on the wire, and it deliberately carries no copy of the
   * original — not its body, not its attachments, not its quote block. The SERVER reads the original
   * from the account, refuses a `no_forward` one, builds the quote and streams the attachments from
   * IMAP at send (`send-service.ts`); a client-assembled quote is exactly the seam a redacted
   * sensitive body would escape through, so the client is never trusted with it.
   *
   * PERSISTED in the scratch buffer, unlike {@link attachments}: it is one short string, and a
   * reload that kept the subject and the note but silently turned the message back into a plain
   * compose would send an empty mail with "Fwd:" on it. Guarded field-wise on read like
   * {@link fromMailboxId}, so a buffer written before this field existed restores as a plain
   * compose.
   *
   * `null`/absent is the ordinary case. It is the EXCLUSIVE PEER of the mutation's `inReplyTo`,
   * which `composePlan` keeps `null` — a forward threads onto no conversation (`types.ts`).
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
 * `localStorage` key for the compose scratch buffer — one per ACCOUNT, not one per browser.
 *
 * It used to be the bare constant below, and "one, because there is one compose" was true about
 * the SURFACE and wrong about the STORAGE. `localStorage` is per-origin, not per-session, and
 * nothing cleared this key on sign-out: `clearBootCaches()` removes the `ohmail.boot.` prefix
 * only and `clearAllMirrors()` is IndexedDB. So an unfinished message — recipients, subject,
 * body — written by one account survived into the next account to sign in on the same browser,
 * where the composer restored it and autosave could persist it as THEIR server draft.
 *
 * The owner suffix is the same shape `searchSortKey` already uses, for the same reason and with
 * the same `"local"` fallback: a device with no account (the standalone desktop, and any moment
 * before sign-in) is a real situation rather than a missing value.
 *
 * The legacy key is drained rather than read. Reading it once "to migrate" is exactly the leak
 * — the migrating reader has no way to know whose draft it is.
 */
export function composeDraftKey(owner: string | null = readOwner()): string {
  return `ohmail.ui.compose.${owner ?? "local"}`;
}

/** The un-owned key this browser may still hold. Removed on clear, never read. */
export const LEGACY_COMPOSE_DRAFT_KEY = "ohmail.ui.compose";

/**
 * The scratch buffer, and what it is NOT.
 *
 * This is the client's own draft, in this browser, exactly like the per-message reply buffer.
 * It is not an IMAP draft and it is not a `drafts` row on the server: nothing is written to
 * the account until Send is pressed, because a draft-per-keystroke is a write storm and an
 * orphan-row factory (`POST /drafts` has no delete-on-abandon path the client drives). Server
 * drafts on the mailbox are a later phase, and when they arrive they belong on the mailbox
 * itself; the compose surface therefore says "kept in this browser" and nothing stronger.
 *
 * Storage can refuse — Safari private mode throws on write — and a refusal must never break
 * composing, so every access is wrapped and a failure simply means the draft lives for as
 * long as the tab does.
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

export function writeComposeDraft(f: ComposeFields): void {
  try {
    /**
     * "EMPTY" IS ABOUT THE TEXT, and `fromMailboxId` deliberately does not count.
     *
     * A sender pick on a form with nothing written in it is not a draft — persisting it would
     * turn every visit to Compose into a stored buffer, and it would make the pick sticky in a
     * way ruling 2 rules out: the default is derived on every fresh compose, and the only thing
     * worth remembering is a pick attached to a message somebody is actually writing.
     *
     * `html` does not count either, and for a sharper reason: an empty ProseMirror document
     * serialises to `<p></p>`, so testing it would make every visit to Compose leave a stored
     * buffer behind. `body` is the editor's plain rendering and is `""` for that document,
     * which is why it is the field that decides. Same rule as `isRichEmpty`.
     */
    if (f.to === "" && f.cc === "" && f.bcc === "" && f.subject === "" && f.body === "") {
      window.localStorage.removeItem(composeDraftKey());
      return;
    }
    // STRIP THE ATTACHMENTS' BYTES. They are held in memory only (see `ComposeFields.attachments`):
    // a photo's worth of base64 would blow a storage quota, and a restored buffer must not claim a
    // paperclip pointing at bytes it no longer holds. Everything textual is persisted as before.
    const { attachments: _drop, ...persisted } = f;
    window.localStorage.setItem(composeDraftKey(), JSON.stringify(persisted));
  } catch {
    /* private mode refuses writes; the draft lives in React state only */
  }
}

export function clearComposeDraft(): void {
  try {
    window.localStorage.removeItem(composeDraftKey());
    // AND the un-owned key a browser upgraded from an earlier bundle may still hold. This is
    // the only line that touches it: it is drained on the next clear and never read back.
    window.localStorage.removeItem(LEGACY_COMPOSE_DRAFT_KEY);
  } catch {
    /* nothing was stored, so there is nothing to remove */
  }
}

/**
 * IS THIS AN ADDRESS? — checked HERE, before Send lights up, and not by the SMTP server.
 *
 * "An SMTP rejection after the fact is a bad way to learn about a typo": the send path is two
 * requests and a reservation, and a 550 arrives as `unverified` — the one outcome the product
 * cannot resolve for the user. A local check costs nothing and turns "we couldn't confirm
 * this send" back into "that address has no dot in it".
 *
 * ── CONSERVATIVE ON PURPOSE ─────────────────────────────────────────────────────────────
 *
 * The rule is not RFC 5322 and does not try to be — the grammar admits quoted local parts,
 * comments and bare IP-literal domains, and a validator that implemented it would reject
 * nothing anyone types by hand while adding a page of code. What it DOES do is refuse the
 * four things a human actually mistypes: no `@`, two `@`, no dot in the domain, and a stray
 * space. Anything past that is the server's business, which is where a genuinely exotic but
 * legal address is still accepted — this gate only decides whether Send is offered.
 *
 * It must never reject a valid ordinary address, so `+` tags, dots, dashes, apostrophes and
 * underscores in the local part all pass, and so do multi-label domains and long TLDs.
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
 * One line of typed text → recipients.
 *
 * Commas and semicolons both separate, because every mail client accepts both and a user who
 * pastes a list from elsewhere has no idea which one they got. `Name <addr>` is accepted
 * because that is what copying a recipient out of another client yields; the display name is
 * kept, so the person's name survives into `drafts.to` and out onto the wire's To header.
 *
 * De-duplicated case-insensitively on the address: a list pasted twice must not mail anyone
 * twice, and the SMTP envelope is built straight from this array (`SendService` →
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
 * The compose form as a send, or as the reason it is not one yet.
 *
 * ── A TYPO BLOCKS THE WHOLE SEND, IT DOES NOT SILENTLY DROP ONE RECIPIENT ──────────────
 *
 * `to` is `[]` whenever ANYTHING failed to parse, even if three of four entries were fine.
 * That is the load-bearing line in this function: it means the refusal is expressed in the
 * MUTATION rather than as a second predicate beside `canSend`, so every caller — the button's
 * `disabled`, the state machine's own guard, a keyboard shortcut, a future Reply Run — is
 * stopped by the same rule with no way around it. Dropping the bad entry and mailing the rest
 * would be the worst option available: the user would learn about the typo from the person who
 * never answered.
 *
 * ── AN EMPTY SUBJECT SENDS ──────────────────────────────────────────────────────────────
 *
 * It does not block and it does not open a confirm dialog. Blocking would be wrong — a
 * subjectless message is legitimate mail and every client sends one — and a modal
 * confirmation is the exact shape Compose was moved away from to begin with — a dialog the
 * keyboard could not leave. So `noSubject` is surfaced as a factual note in the send row,
 * BEFORE the press rather than as a dialog after it, which is the same warning arriving early
 * enough to be useful.
 *
 * `mailboxId` is omitted rather than nulled when nothing can name one, so `canSend` refuses and
 * `Engine.enrich` has nothing to disagree with.
 *
 * ── IT IS HANDED THE ANSWER, IT DOES NOT CHOOSE ─────────────────────────────────────────
 *
 * `mailboxId` is `resolveComposeFrom(...).mailboxId` — the user's revalidated pick or
 * the derived default — resolved by the caller so that the id on the wire is the same object
 * the From line rendered. Passing `fields.fromMailboxId` straight through here would be the bug
 * this resolution removes wearing a different hat: a pick stored days ago against a mailbox since
 * disconnected would go out and collect a 409 nobody could act on.
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
