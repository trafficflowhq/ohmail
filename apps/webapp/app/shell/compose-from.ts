/**
 * Which address is answering — one rule, four surfaces (the old default was the newest message's mailbox: a
 * coin toss re-flipped on every arrival, with no From line on screen). A fresh compose defaults to the OLDEST
 * CONNECTED mailbox, derived every time, nothing stored (the explicit pick is remembered per draft). A compose
 * addressed to a domain the account sends from takes that address and says so; own addresses are read past. A
 * reply keeps the arrival mailbox and says so; a substitution is stated, never refused. A forward is a reply
 * here; a reopened draft is a pick. The value is a mailbox id, never an address. Sendable is `!== "disabled"`
 * (mirrors the server: `error` is an IMAP verdict, SMTP is a different transport); the default still prefers
 * `connected`. Pure: the view renders from these functions and `AppShell` builds the mutation from them.
 */

import type { EmailAddress } from "@ohmail/client-engine";
import { parseRecipients } from "./compose";

/** One mailbox, as a From line is entitled to know it. */
export interface FromOption {
  /** The selector's value. Never an address — see the header. */
  id: string;
  address: string;
  /** May this be the sender today? `status !== "disabled"`, matching `SendService.reserve`. */
  sendable: boolean;
  /** Healthy. The fresh-compose default prefers these. */
  connected: boolean;
  /**
   * The biggest message THIS mailbox's submission server said it will accept, in bytes, or `null`
   * when it announced none (and on every surface that cannot read `GET /mailboxes` at all).
   *
   * It travels with the From option and not beside it because the ceiling is per-MAILBOX: an
   * account with two addresses on two providers has two different answers, and the one that
   * applies is the one the user is sending from. It is NOT the cap on its own — see
   * `composeAttachCap` in `../components/ComposeAttach`.
   */
  maxMessageBytes: number | null;
}

/** The subset of {@link import("./mail-state").MailboxFacts} this module reads. */
interface FactsShape {
  id: string;
  address: string;
  status: string;
  createdAt: string;
  smtpMaxSizeBytes?: number | null;
}

/**
 * `GET /mailboxes` → the options, **oldest first**.
 *
 * The order is the rule, not a presentation choice: "the oldest connected mailbox" is the
 * default, and sorting here is what lets every consumer express that as "the first sendable
 * one" instead of re-deriving a comparison. `createdAt` is NOT NULL server-side, and ties fall
 * back to the id so the order is total — two mailboxes connected inside the same millisecond
 * must not swap places between renders.
 */
export function optionsFromFacts(facts: readonly FactsShape[]): FromOption[] {
  return [...facts]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .map((m) => ({
      id: m.id,
      address: m.address,
      sendable: m.status !== "disabled",
      connected: m.status === "connected",
      // `?? null` collapses "this API predates the column" and "the server announced no ceiling",
      // and here that is correct rather than the seam mistake `CloudShell` avoids: both mean
      // exactly "no measured ceiling for this mailbox", and the compose surface resolves them to
      // the same fallback. There is no third reading for the distinction to serve.
      maxMessageBytes: m.smtpMaxSizeBytes ?? null,
    }));
}

/** The subset of the mirror's `"mailbox"` entity this module reads. */
interface MirrorShape {
  id: string;
  address: string;
}

/**
 * The mirror's `"mailbox"` entities → the options, in mirror order — the demo and the Desktop
 * (`/sync` never emits a mailbox entity; only the FixturesAdapter seeds these rows). `status` is
 * deliberately not read: the fixture shape carries a capitalised display label, not the lifecycle
 * union, so filtering on it would drop every demo mailbox and leave the demo with no From line —
 * the exact silence this gap is about; a seeded mailbox is one somebody put there on purpose.
 * Mirror order rather than `createdAt` because these rows have no such field; the fixture order is
 * authored, so "the first one" is a decision, not a scan artefact.
 */
export function optionsFromMirror(entities: readonly MirrorShape[]): FromOption[] {
  return entities
    .filter((m) => typeof m.id === "string" && m.id.length > 0 && typeof m.address === "string")
    // `maxMessageBytes: null` — a mirror row carries no server announcement, so the compose
    // surface states the product constant here, exactly as it did before the field existed.
    .map((m) => ({ id: m.id, address: m.address, sendable: true, connected: true, maxMessageBytes: null }));
}

/**
 * The default sender: the oldest CONNECTED mailbox, else the oldest that can send at all.
 *
 * `options` must already be oldest-first — see {@link optionsFromFacts}.
 */
export function defaultFrom(options: readonly FromOption[]): FromOption | null {
  return options.find((o) => o.connected && o.sendable) ?? options.find((o) => o.sendable) ?? null;
}

/** What a From line shows and what the mutation carries. One object, so they cannot disagree. */
export interface ResolvedFrom {
  /**
   * The id the send must carry, or `null` when the options cannot name one.
   *
   * `null` is "we cannot see this account's mailboxes" (Desktop, demo without fixtures, a Cloud
   * tab whose first poll has not landed) — NOT "there are none". The caller falls back to the
   * mirror-derived id for the wire and renders no From line, which is what the surface did
   * before this change and is still the honest answer when nothing can be named.
   */
  mailboxId: string | null;
  /** The address to render, or `null` when nothing can be named. */
  address: string | null;
  /** What the selector may offer. Sendable only — a disabled mailbox is never a choice. */
  choices: FromOption[];
  /** True when {@link ResolvedFrom.mailboxId} is NOT the mailbox that was asked for. */
  substituted: boolean;
  /** The address that was asked for and refused, when it can be named. Copy uses it. */
  substitutedFrom: string | null;
  /**
   * What the CHOSEN mailbox's submission server said it will accept, in bytes, or `null`.
   *
   * On this object rather than looked up from `choices` for the reason the whole object exists:
   * the screen and the wire must agree. The From line, the mutation's `mailboxId` and the
   * attachment ceiling the form states are three consequences of ONE resolution, and a surface
   * that re-derived the third from a mailbox id could state a ceiling belonging to a different
   * address than the one it is sending from.
   */
  maxMessageBytes: number | null;
  /**
   * True when the sender was MOVED OFF the derived default because a
   * recipient stands on this mailbox's own domain
   * ({@link domainMatchedFrom}); the surface must say so. It is a change
   * that happened while the user was looking at another field — the only
   * reason it needs a line: false whenever the resolution is what it would
   * have been anyway, including when the matched mailbox IS the default (a
   * notice about a switch nobody made is the same untruth as a switch
   * nobody was told about). Always false on a reply.
   */
  domainMatched: boolean;
}

const NOTHING: ResolvedFrom = {
  mailboxId: null,
  address: null,
  choices: [],
  substituted: false,
  substitutedFrom: null,
  maxMessageBytes: null,
  domainMatched: false,
};

function resting(options: readonly FromOption[], chosen: FromOption | null): ResolvedFrom {
  return {
    mailboxId: chosen?.id ?? null,
    address: chosen?.address ?? null,
    choices: options.filter((o) => o.sendable),
    substituted: false,
    substitutedFrom: null,
    maxMessageBytes: chosen?.maxMessageBytes ?? null,
    domainMatched: false,
  };
}

/**
 * An address folded to the one form this module compares in: trimmed and lowercased, whole. The
 * same normalisation as the server's `awayNormalizeAddress`, written out rather than imported
 * (`app/shell/**` depends on no server package); one function because three places ask whether an
 * address belongs to the account, and three inline folds drift. Folding the LOCAL PART departs from
 * the RFC, which lets a provider tell `Dana@` from `dana@` — the costs differ: folding too much
 * only declines an auto-switch; folding too little moves the sender of a message the user addressed
 * to themselves, the case this rule exists to leave alone.
 */
function foldAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The same address with its `+`-tag removed — the key the own-address question is asked with.
 * `me+notes@acme.example` is `me@` wearing a filing label, and the whole-address comparison read it
 * as a stranger on the account's own domain and moved the sender. A `+` tag is a convention, not a
 * guarantee, so this is a GUESS made only where a wrong guess is cheap: it changes exactly one case
 * — a recipient whose base IS one of the account's own — and the cost of wrong is a declined
 * auto-switch. {@link foldAddress} deliberately does NOT do this: the reply helpers filter
 * recipients out of an envelope, where a wrong guess drops somebody from a reply — the expensive
 * direction. A local part beginning with `+` is left whole: no base in front of the tag.
 */
function ownAddressKey(address: string): string {
  const folded = foldAddress(address);
  const at = folded.lastIndexOf("@");
  if (at <= 0) return folded;
  const plus = folded.indexOf("+");
  return plus > 0 && plus < at ? folded.slice(0, plus) + folded.slice(at) : folded;
}

/**
 * Every address the account itself holds, folded — including the ones it cannot send from. The
 * options ARE the account's mailboxes; `optionsFromFacts` maps `GET /mailboxes` whole and a
 * disabled mailbox arrives carrying `sendable: false` rather than being dropped: an address you can
 * no longer send from is still yours, and a message to it is still a message to yourself — the same
 * set, and reason, as the away responder's own-address suppression. No aliases because the product
 * has none; when a mailbox holds several this is the one place they join. Keyed by {@link
 * ownAddressKey}, so the membership test uses the same key.
 */
function ownAddressSet(options: readonly FromOption[]): Set<string> {
  return new Set(options.map((o) => ownAddressKey(o.address)));
}

/**
 * The domain of an address, case-folded — in the WIRE FORM it is stored in, always.
 *
 * `lastIndexOf`, not `indexOf`: an address that reached here has already been through
 * `isEmailAddress`, but a mailbox fact comes from the server and this must not read a local part
 * as a domain if one ever carries an `@`.
 */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * The address the recipient's domain names — or `null`, most of the time (two businesses' addresses
 * share one fresh-compose default, so mail to the other business left from the wrong company). One
 * answer or none: the whole recipient set must point at exactly ONE sendable own mailbox — two own
 * domains, or two own mailboxes on one domain, leave the default alone. Sendable is `!==
 * "disabled"`; a match that has to be undone is worse than none. Wire forms compared (both sides
 * punycode). Your own addresses are not recipients here — read past per RECIPIENT, so a mixed set
 * is decided by the strangers alone; the own set includes disabled mailboxes ({@link
 * ownAddressSet}) and is asked with {@link ownAddressKey}.
 */
export function domainMatchedFrom(
  options: readonly FromOption[],
  recipients: readonly string[],
): FromOption | null {
  const mine = ownAddressSet(options);
  let hit: FromOption | null = null;
  for (const recipient of recipients) {
    if (mine.has(ownAddressKey(recipient))) continue;
    const domain = domainOf(recipient);
    if (domain === null) continue;
    for (const option of options) {
      if (!option.sendable || domainOf(option.address) !== domain) continue;
      if (hit !== null && hit.id !== option.id) return null;
      hit = option;
    }
  }
  return hit;
}

/**
 * Fresh compose — the user's pick if it is still a real choice, else the derived default. A stored
 * pick is REVALIDATED, not trusted: the mailbox it names can be disconnected, and replaying it
 * collects a 409. The fallback is silent on purpose (a compose has no promised sender). The
 * recipient gets a vote only while nobody has picked: the gate is `picked === null` — the FIELD's
 * state — so once set, no later To edit moves the sender; a reopened draft arrives set from its
 * row, deliberately not re-derived (a pre-rule draft keeps its stale sender — the smaller, visible
 * error). Nothing here writes `fromMailboxId`: the match is re-derived per render, so deleting the
 * recipient un-switches. To line only — a bystander's Cc domain must not decide who is writing.
 */
export function resolveComposeFrom(
  options: readonly FromOption[],
  picked: string | null,
  recipientLine = "",
): ResolvedFrom {
  if (options.length === 0) return NOTHING;
  const kept = picked === null ? null : options.find((o) => o.id === picked && o.sendable) ?? null;
  if (kept) return resting(options, kept);
  const derived = defaultFrom(options);
  if (picked !== null) return resting(options, derived);
  const matched = domainMatchedFrom(
    options,
    parseRecipients(recipientLine).addresses.map((a) => a.address),
  );
  if (matched === null || matched.id === derived?.id) return resting(options, matched ?? derived);
  return { ...resting(options, matched), domainMatched: true };
}

/**
 * Reply / forward — the mailbox the message arrived in, and the substitution said out loud. `inherited` is
 * `parent.mailboxId`, what `Engine.enrich` already puts on the wire; this makes it visible and handles the one
 * case where it is unavailable. A reply has a right answer — the address the sender wrote to — so sending from
 * a different one is announced (`substituted`), unlike the compose fallback. It never blocks: a disabled parent
 * mailbox with a sendable default still sends (the server's 409 is the backstop). A mailbox absent from the
 * options counts as substituted — the caller must pass `[]`, never a partial list, when it cannot see. An
 * explicit pick is a statement, not a substitution: it stands with `substituted` FALSE; a pick that no longer
 * names a sendable option is dropped and the inherited derivation runs verbatim.
 */
export function resolveReplyFrom(
  options: readonly FromOption[],
  inherited: string | null,
  override: string | null = null,
): ResolvedFrom {
  if (options.length === 0) return NOTHING;
  if (override !== null) {
    const picked = options.find((o) => o.id === override && o.sendable) ?? null;
    if (picked) return resting(options, picked);
  }
  const own = inherited === null ? null : options.find((o) => o.id === inherited) ?? null;
  if (own?.sendable) return resting(options, own);
  const chosen = defaultFrom(options);
  return {
    mailboxId: chosen?.id ?? null,
    address: chosen?.address ?? null,
    choices: options.filter((o) => o.sendable),
    // Nothing to substitute WITH is not a substitution — it is a send that cannot happen, and
    // the server says so in words. Claiming one here would name an address we are not using.
    substituted: chosen !== null && inherited !== null,
    substitutedFrom: chosen !== null && inherited !== null ? own?.address ?? null : null,
    // The SUBSTITUTE's ceiling, not the inherited mailbox's: this reply leaves from `chosen`, so
    // the number a surface states has to be the one that will actually be enforced.
    maxMessageBytes: chosen?.maxMessageBytes ?? null,
    // NEVER on a reply. Its sender is the mailbox the message ARRIVED IN — a fact about the
    // conversation — so who the answer is addressed to has no say in it, and this function is
    // handed no recipients to change its mind with.
    domainMatched: false,
  };
}

/**
 * Who a reply is addressed to — the sender, UNLESS you were the sender. `Engine.enrich` defaults a
 * reply's recipient to `[parent.from]` — right ordinarily; on a message YOU sent, that addresses
 * the reply back to your own mailbox and the correspondent never hears it. When `parent.from` is
 * one of `ownAddresses`, the reply goes to whom the message was addressed TO, with your own
 * addresses filtered out; a message to yourself alone leaves nothing, and there `[parent.from]` is
 * restored rather than a reply with no recipient. Returns `null` for the ordinary case (enrich
 * keeps owning it) and when `ownAddresses` is empty — the demo, the Desktop, a provider-less pane:
 * no way to know the parent is self-authored, so the default stands rather than a guess.
 */
export function replyRecipients(
  parent: { from: EmailAddress; to: readonly EmailAddress[] },
  ownAddresses: readonly string[],
): EmailAddress[] | null {
  const mine = new Set(ownAddresses.map(foldAddress));
  if (mine.size === 0) return null;
  if (!mine.has(foldAddress(parent.from.address))) return null;
  const others = parent.to.filter((r) => !mine.has(foldAddress(r.address)));
  return others.length > 0 ? [...others] : [parent.from];
}

/** The reply-all envelope: who stands on the To line, and who rides Cc. */
export interface ReplyAllRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

/**
 * Who a reply to all is addressed to — or `null` when "all" is nobody beyond the plain reply. The
 * `null` is the visibility rule: a surface offers Reply all exactly when this returns an envelope,
 * and the send path asks the SAME call. Envelope: the sender leads To, then every other To
 * recipient minus the reader; the parent's Cc keeps its line minus the reader; nobody twice.
 * Self-authored parent: offered only when the Cc line survives the self-filter. No `ownAddresses`:
 * offered from two DISTINCT recipients, withheld at one. Distinct people, not header slots: `to +
 * cc` once counted one address on both lines as two, offering Reply all on a 1:1 message — the gate
 * counts the folded set across both lines.
 */
export function replyAllRecipients(
  parent: { from: EmailAddress; to: readonly EmailAddress[]; cc?: readonly EmailAddress[] },
  ownAddresses: readonly string[],
): ReplyAllRecipients | null {
  const fold = foldAddress;
  const mine = new Set(ownAddresses.map(fold));
  const sender = fold(parent.from.address);
  const cc = parent.cc ?? [];
  /** One appearance per address across BOTH lines, reader excluded. Order is the parent's. */
  const seen = new Set<string>();
  const others = (list: readonly EmailAddress[]): EmailAddress[] =>
    list.filter((r) => {
      const a = fold(r.address);
      if (mine.has(a) || seen.has(a)) return false;
      seen.add(a);
      return true;
    });

  if (mine.size > 0 && mine.has(sender)) {
    // Self-authored. The To line is the plain reply's own answer; only a surviving Cc line
    // makes "all" mean more than "reply", so its absence is the degenerate case here.
    const toOthers = others(parent.to);
    const ccOthers = others(cc);
    if (ccOthers.length === 0) return null;
    return { to: toOthers.length > 0 ? toOthers : [parent.from], cc: ccOthers };
  }

  // Ordinary case: the sender leads To and never repeats in either line.
  seen.add(sender);
  const toOthers = others(parent.to);
  const ccOthers = others(cc);
  if (toOthers.length === 0 && ccOthers.length === 0) return null;
  // Reader unknown: one listed PERSON is (almost always) the reader — see the header. Folded
  // across both lines, so one address in To and Cc counts once instead of filling the quota.
  const listed = new Set([...parent.to, ...cc].map((r) => fold(r.address)));
  if (mine.size === 0 && listed.size < 2) return null;
  return { to: [parent.from, ...toOthers], cc: ccOthers };
}

/* ── the editable reply envelope ───────────────────────────────────────────────────────── */

/**
 * WHAT THE USER TYPED OVER THE COMPUTED AUDIENCE — three wire strings, or `null` for a head
 * nobody has opened.
 *
 * `null` is load-bearing: it means "the computed envelope applies", and the computed path
 * below is byte-for-byte what `sendReply` always built — so a reply whose recipients were
 * never touched sends exactly what it sent before this field existed. The strings are the
 * same comma-separated wire shape `ComposeFields.to` holds, edited by the same chip field.
 */
export interface ReplyEnvelopeEdit {
  to: string;
  cc: string;
  bcc: string;
}

/** The reply envelope as it would go on the wire, plus the entries that refused to parse. */
export interface ReplyEnvelopePlan {
  /** `null` ⇒ the field stays off the mutation and `Engine.enrich` keeps owning the default. */
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  invalid: { to: string[]; cc: string[]; bcc: string[] };
}

/**
 * One envelope for a reply — the computed audience, or the user's edit of it. `composePlan`'s
 * discipline: `InlineReply` judges the lock with this and `AppShell.sendReply` builds the wire from
 * it, so the head, the button and the envelope cannot be three opinions. Untouched (`edit ===
 * null`): exactly the derivation `sendReply` always made — `replyAllRecipients`, `replyRecipients`
 * for the self-authored plain case, else `null` so `Engine.enrich` keeps deriving `[parent.from]`;
 * `bcc` is NEVER derived — a blind recipient exists only when somebody typed one. Edited: parsed
 * with the compose form's own parser and rule — a typo in any row empties the whole envelope, and
 * the emptied `to` is what `canSend` refuses.
 */
export function replyEnvelopePlan(
  parent: { from: EmailAddress; to: readonly EmailAddress[]; cc?: readonly EmailAddress[] } | null,
  ownAddresses: readonly string[],
  replyAll: boolean,
  edit: ReplyEnvelopeEdit | null,
): ReplyEnvelopePlan {
  const none = { to: [], cc: [], bcc: [] };
  if (edit === null) {
    const all = replyAll && parent ? replyAllRecipients(parent, ownAddresses) : null;
    const to = all ? all.to : parent ? replyRecipients(parent, ownAddresses) : null;
    return { to, cc: all && all.cc.length > 0 ? all.cc : null, bcc: null, invalid: none };
  }
  const to = parseRecipients(edit.to);
  const cc = parseRecipients(edit.cc);
  const bcc = parseRecipients(edit.bcc);
  const anyInvalid = to.invalid.length + cc.invalid.length + bcc.invalid.length > 0;
  return {
    to: anyInvalid ? [] : to.addresses,
    cc: anyInvalid || cc.addresses.length === 0 ? null : cc.addresses,
    bcc: anyInvalid || bcc.addresses.length === 0 ? null : bcc.addresses,
    invalid: { to: to.invalid, cc: cc.invalid, bcc: bcc.invalid },
  };
}

/**
 * The plan's recipient fields exactly as the mutation carries them. One spread, used by BOTH
 * the lock (`InlineReply` → `canSend`) and the wire (`AppShell.sendReply`) — a key present in
 * one and absent in the other is how a button and an envelope drift apart.
 */
export function replyEnvelopeOnWire(
  plan: ReplyEnvelopePlan,
): { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] } {
  return {
    ...(plan.to !== null ? { to: plan.to } : {}),
    ...(plan.cc !== null ? { cc: plan.cc } : {}),
    ...(plan.bcc !== null ? { bcc: plan.bcc } : {}),
  };
}

/**
 * Addresses → the one wire string the chip field edits — the prefill when a reply head opens. A
 * display name rides along only when `parseRecipients` can read it back: the split is blind to
 * quoting, so a name containing a separator or angle bracket ("Doe, John") would come back as two
 * broken entries — such a name is dropped and the bare address kept; the envelope is the address,
 * the name is sugar the parent's headers still hold. The same rule and character class as
 * `formatRecipient` (`@ohmail/client-engine`), kept separate only because they take different
 * inputs.
 */
export function formatRecipientLine(list: readonly EmailAddress[]): string {
  return list
    .map((a) => (a.name && !/[<>,;"]/.test(a.name) ? `${a.name} <${a.address}>` : a.address))
    .join(", ");
}

/**
 * The same line, ENDING IN A SEPARATOR — the prefill for a field whose entries are settled.
 *
 * `splitRecipients` reads the final segment of the value as the tail still being typed, so a
 * prefill that stops at the last address renders that address as raw text in the input — no ×,
 * typing appends to it — while everything before it is a chip. A stored recipient is settled,
 * not half-typed, so every surface that seeds a recipient field from ADDRESSES (a reopened
 * draft, the reply head opening for edit, the contact popover's Write) ends the string with
 * `", "`; `parseRecipients` ignores the empty segment, so nothing on the wire changes.
 */
export function formatRecipientChips(list: readonly EmailAddress[]): string {
  const line = formatRecipientLine(list);
  return line === "" ? "" : `${line}, `;
}
