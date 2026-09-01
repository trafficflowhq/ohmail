/**
 * WHICH ADDRESS IS ANSWERING — one rule, four surfaces.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * A fresh compose resolved its sender through `sendingMailboxId` (`selectors.ts`), which
 * returns the mailbox of the account's NEWEST MESSAGE. On an account with two connected
 * addresses that is a coin toss re-flipped every time mail arrives: the From line moved
 * whenever the other address received something, and the compose surface rendered no From at
 * all, so nothing on screen said which one had won. A stranger could not tell what address
 * they were writing from even with a single mailbox connected.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────
 *
 *  · A fresh compose defaults to the OLDEST CONNECTED mailbox — `createdAt` ascending. It is
 *    DERIVED, every time, and nothing stores it: most-recently-used drifts under the user,
 *    newest-message is the roulette this replaces, and "primary mailbox" is not a concept this
 *    product has. What IS remembered is the user's explicit pick, and only for the draft they
 *    picked it on (`ComposeFields.fromMailboxId`).
 *  · A fresh compose ADDRESSED TO A DOMAIN THE ACCOUNT ITSELF SENDS FROM takes that address
 *    instead, and says on screen that it did (`domainMatchedFrom`). Still derived, still nothing
 *    stored, still overridable by the selector beside it — it changes which default applies, not
 *    what a default is. It declines wherever a second reading exists.
 *  · A reply keeps the mailbox the message arrived in (`Engine.enrich` → `parent.mailboxId`)
 *    and now SAYS so. If that mailbox can no longer send, the default is substituted and the
 *    substitution is stated on screen — never silently, and never by refusing the reply. Nothing
 *    about a reply's recipients moves its sender: that rule is the compose surface's alone.
 *  · A FORWARD is a compose for this purpose, and the code says so rather than the prose: it
 *    seeds the ordinary form with `EMPTY_COMPOSE` (`AppShell.forwardMessage`), so it carries no
 *    pick, no recipients and no inherited mailbox — `forwardOf` rides the send request only. The
 *    user addresses it themselves, which is exactly the act the rule above reads. A DRAFT reopened
 *    from the drafts list is the other way round: `openDraft` seeds `fromMailboxId` from the row,
 *    which is a pick, so nothing is re-derived over it.
 *  · The value is a mailbox **id**, never an address. Aliases are a later slice and the day one
 *    mailbox carries three addresses an address-keyed selector has no answer; an id keeps its
 *    meaning through that change.
 *
 * ── SENDABLE IS `!== "disabled"`, NOT `=== "connected"` ─────────────────────────────────
 *
 * This mirrors the server exactly, and the server's reasoning is load-bearing: when the server
 * reserves a send it refuses ONLY
 * `'disabled'`, because `'error'` is the sync worker's verdict about IMAP and SMTP is a
 * different transport — a mailbox that cannot be READ may still be able to SEND, and an
 * `error` the user cannot clear would strand their outbox on a transient fault they did not
 * cause. `sync_blocked_reason` is excluded for the same reason: it is a note about our own
 * infrastructure, written without touching `status` at all. A UI that offered fewer mailboxes
 * than the server accepts would be inventing a refusal nobody wrote.
 *
 * The DEFAULT still prefers `connected` (ruling 2 says so), and falls back to merely sendable
 * only when nothing is connected — otherwise an account whose one healthy mailbox is in
 * `error` would have no default at all.
 *
 * ── PURE, AND THAT IS THE POINT ─────────────────────────────────────────────────────────
 *
 * The screen and the wire have to agree. `ComposeView` renders from these functions and
 * `AppShell` builds the mutation from them, so there is no second implementation for one of
 * them to drift into — the same discipline as `canSend` in `mail-send.ts`.
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
 * The MIRROR's `"mailbox"` entities → the options, in mirror order.
 *
 * This is the demo and the Desktop. `"mailbox"` is not one of the change log's entity types, so
 * `/sync` never emits one and only the FixturesAdapter seeds these rows — which is why the Cloud
 * path above exists at all.
 *
 * **`status` IS DELIBERATELY NOT READ HERE.** The fixture shape carries a capitalised display
 * label (`"Connected"`, `packages/fixtures/src/data.ts:34`), not the three-member lifecycle
 * union the server uses, so filtering on it would drop every demo mailbox and leave the demo
 * with no From line — the exact silence this gap is about. A seeded mailbox is one somebody put
 * there on purpose; there is no disabled one to hide.
 *
 * Mirror order rather than `createdAt` because these rows have no such field. The fixture order
 * is stable and authored, so "the first one" is a decision somebody made rather than a scan
 * artefact.
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
   * True when the sender was MOVED OFF the derived default because a recipient stands on this
   * mailbox's own domain — see {@link domainMatchedFrom}. The surface must say so.
   *
   * It is a change that happened while the user was looking at another field, which is the only
   * reason it needs a line at all: false whenever the resolution is what it would have been
   * anyway, including when the matched mailbox IS the default. A notice about a switch nobody
   * made is the same untruth as a switch nobody was told about.
   *
   * Always false on a reply — {@link resolveReplyFrom} has no recipients to read.
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
 * THE ADDRESS THE RECIPIENT'S DOMAIN NAMES — or `null`, which is most of the time.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * An account holding two businesses' addresses has ONE fresh-compose default (the oldest
 * connected mailbox, see the header), so every message to a customer of the other business left
 * from the wrong company until somebody noticed the From line. The recipient is the evidence that
 * was on screen the whole time: a message to `dana@acme.example` from an account that can send as
 * `me@acme.example` is almost never meant to leave from the other identity.
 *
 * ── ONE ANSWER OR NONE ──────────────────────────────────────────────────────────────────
 *
 * The whole recipient set must point at exactly ONE of the account's sendable mailboxes. Two
 * recipients naming two different own domains is a message that belongs to neither identity more
 * than the other, and two of the account's own mailboxes on one domain is a question this rule
 * cannot answer — both leave the default alone. Reading the To line left to right and taking the
 * first hit would be a coin toss with an explanation attached, which is the defect being fixed
 * wearing a new hat.
 *
 * So "the first recipient wins" is true only in the sense that survives that rule: the earliest
 * matching recipient's mailbox is the answer, and it is the answer only because no later one
 * named a different mailbox. Several recipients on the SAME own domain are one answer reached
 * twice, not a tie.
 *
 * ── SENDABLE, AND NOTHING ELSE ──────────────────────────────────────────────────────────
 *
 * `sendable` is the same `!== "disabled"` the rest of this module uses, so a mailbox in `error`
 * can still be matched (an IMAP verdict is not an SMTP one) and a disabled one is never proposed
 * — the server would refuse it, and a match that has to be undone is worse than none. When the
 * disabled mailbox was the account's ONLY address on that domain nothing matches at all and the
 * derived default stands: a domain the account cannot currently send from is not an invitation to
 * nominate a different identity.
 *
 * ── AND IT COMPARES WIRE FORMS ──────────────────────────────────────────────────────────
 *
 * Both sides are punycode already: mailbox addresses are stored in their A-label form, and the
 * compose recipient field is one of the two surfaces `idn.ts` deliberately leaves undecoded
 * because its content IS the wire value. `displayAddress` is never called here — decoding is
 * presentation, and its documented fallback (a label that refuses to decode is shown raw) would
 * make two identical domains stop matching each other.
 *
 * @param recipients the addresses typed on the To line, in order, already parsed.
 */
export function domainMatchedFrom(
  options: readonly FromOption[],
  recipients: readonly string[],
): FromOption | null {
  let hit: FromOption | null = null;
  for (const recipient of recipients) {
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
 * FRESH COMPOSE — the user's pick if it is still a real choice, else the derived default.
 *
 * A stored pick is REVALIDATED rather than trusted. The scratch buffer survives days, a tab and
 * a reload; the mailbox it names can be disconnected in the meantime, and replaying it would
 * put a stale id on the wire and collect a 409 the user cannot act on. Falling back to the
 * default is silent ON PURPOSE here and not in {@link resolveReplyFrom}: a compose has no
 * mailbox it was supposed to answer from, so there is no promise to break — the From line
 * simply shows what it will send from, which is the whole point of rendering it.
 *
 * ── THE RECIPIENT GETS A VOTE, AND ONLY WHILE NOBODY HAS PICKED ─────────────────────────
 *
 * `recipientLine` is the To field verbatim. Addressed to a domain the account itself sends from,
 * the default is replaced by that address and `domainMatched` says so
 * ({@link domainMatchedFrom} holds the whole rule, including every case where it declines).
 *
 * The gate is `picked === null` — the FIELD's state, not whether the id it holds still resolves.
 * A user who chose an address has already taken the decision this would take for them, and a pick
 * that has gone stale falls back to the plain derivation exactly as it did before this existed.
 *
 * ── IT IS A DERIVED DEFAULT AND NOTHING ELSE ────────────────────────────────────────────
 *
 * Nothing here writes `ComposeFields.fromMailboxId`. The match is re-derived on every render from
 * the recipients on screen, so deleting the recipient un-switches the sender, and the id reaches
 * the wire down the SAME path the oldest-connected default takes (`AppShell` → `composeMailbox` →
 * `composePlan`). Storing it would make one derived guess sticky for every later recipient in the
 * draft, and would be indistinguishable — to this function, on the next render — from a choice the
 * user made.
 *
 * The To line only. A Cc is a copy, and letting a bystander's domain decide which identity is
 * writing is a switch the user has more reason to be surprised by than helped by.
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
 * REPLY / FORWARD — the mailbox the message arrived in, and the substitution said out loud.
 *
 * `inherited` is `parent.mailboxId`, which is what `Engine.enrich` already puts on the wire
 * (`engine.ts:671`). This slice does not change that default; it makes it visible, and it
 * handles the one case where the default is not available.
 *
 * ── WHY A SUBSTITUTION IS ANNOUNCED AND A COMPOSE FALLBACK IS NOT ───────────────────────
 *
 * A reply has a right answer — the address the sender wrote to — and sending from a different
 * one changes who the recipient sees answering. Doing that without saying so is the class of
 * defect this whole gap is about, one layer deeper: the roulette at least never claimed
 * anything. So `substituted` is true whenever the answer is not the inherited mailbox, and the
 * surface must say so.
 *
 * ── AND IT NEVER BLOCKS ─────────────────────────────────────────────────────────────────
 *
 * A disabled parent mailbox with a sendable default still sends. Refusing would be a reply the
 * user cannot make about a decision they did not take; the server's 409 is the backstop for the
 * case where there is genuinely nothing to substitute.
 *
 * A mailbox ABSENT from the options counts as substituted too: with the options in hand, an id
 * that is not among them is a mailbox that has been removed from the account, not one we simply
 * have not heard about. The caller must pass `[]` — never a partial list — when it cannot see.
 *
 * ── AN EXPLICIT PICK IS A STATEMENT, NOT A SUBSTITUTION ─────────────────────────────────────
 *
 * `override` is the sender the user chose ON THIS REPLY, or `null` while none is chosen. When it
 * names a mailbox that can send it stands as the answer and `substituted` is FALSE: the selector
 * value IS the From line, so there is nothing to announce — a pick and a substitution are
 * different acts and only the second, which the user did not make, gets a notice. A pick that no
 * longer names a sendable option (its address was disabled or removed since) is DROPPED, and the
 * inherited-mailbox derivation below runs verbatim — which is what re-announces a substitution if
 * the mailbox the message arrived in is the one that went away.
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
 * WHO A REPLY IS ADDRESSED TO — the sender, UNLESS you were the sender.
 *
 * `Engine.enrich` defaults a reply's recipient to `[parent.from]` (`engine.ts`, the `mail_send`
 * branch), which is right for the ordinary case: you answer the person who wrote to you. On a
 * message YOU sent — a self-authored message, which a thread shows inline the moment either side
 * has answered — `parent.from` is your OWN address, so that default addresses the reply straight
 * back to your own mailbox and the correspondent never hears it.
 *
 * The signal is the account's own addresses — `ownAddresses`, the same `GET /mailboxes` facts the
 * From line reads (`optionsFromFacts(...).map(o => o.address)`). When `parent.from` is one of
 * them, the reply is addressed to whom the message was addressed TO — the correspondents — with
 * any of your own addresses filtered out so a self-copy never rides along. A message you sent to
 * yourself alone leaves nothing after that filter, and there `[parent.from]` is restored rather
 * than shipping a reply with no recipient.
 *
 * Returns `null` for the ordinary (not-self-authored) case, so the caller omits `to` and lets
 * `enrich` keep owning that path — this speaks up only for the self-authored one. It also returns
 * `null` when `ownAddresses` is empty, which is exactly the surface with no `GET /mailboxes` to
 * read (the demo, the Desktop, a pane mounted with no provider): there is no way to know the
 * parent is self-authored, so the default stands rather than a guess.
 */
export function replyRecipients(
  parent: { from: EmailAddress; to: readonly EmailAddress[] },
  ownAddresses: readonly string[],
): EmailAddress[] | null {
  const mine = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  if (mine.size === 0) return null;
  if (!mine.has(parent.from.address.trim().toLowerCase())) return null;
  const others = parent.to.filter((r) => !mine.has(r.address.trim().toLowerCase()));
  return others.length > 0 ? [...others] : [parent.from];
}

/** The reply-all envelope: who stands on the To line, and who rides Cc. */
export interface ReplyAllRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

/**
 * WHO A REPLY TO ALL IS ADDRESSED TO — or `null` when "all" is nobody beyond the plain reply.
 *
 * The `null` is the visibility rule as well as the degenerate case: a surface offers Reply all
 * exactly when this returns an envelope, so the control cannot appear on a 1:1 message, where
 * "all" and "reply" are the same person and a second button would be noise. The send path asks
 * the SAME call, so what the button promised and what leaves the account are one decision —
 * the discipline this module's header states.
 *
 * ── THE ENVELOPE ─────────────────────────────────────────────────────────────────────────
 *
 * Ordinary case: the sender leads the To line, followed by every other To recipient who is not
 * the reader; the parent's Cc keeps its line, minus the reader. Nobody appears twice (a sender
 * who also stands in To/Cc is dropped there) and the reader is never their own recipient — the
 * same self-filter {@link replyRecipients} applies, case-folded the same way.
 *
 * Self-authored parent (`parent.from` is one of `ownAddresses`): a plain reply already goes to
 * every OTHER To recipient (see {@link replyRecipients}), so reply-all differs only by carrying
 * the Cc line — it is offered only when that line is non-empty after the self-filter.
 *
 * ── WHEN THE READER CANNOT BE TOLD APART ─────────────────────────────────────────────────
 *
 * With no `ownAddresses` (the demo, the desktop shell, a pane with no facts) the self-filter
 * has nothing to filter with. Two listed recipients still prove somebody besides the reader is
 * on the thread — the reader is at most one of them — so the envelope is offered from two and
 * withheld at one, where a lone recipient is almost always the reader and a Reply all on a 1:1
 * mail is exactly the noise the `null` exists to prevent. The reader may then appear among the
 * recipients (there is no way to know which one they are); that is the standard degradation,
 * not a defect, and it disappears the moment the facts are readable.
 *
 * TWO DISTINCT PEOPLE, NOT TWO HEADER SLOTS. The count used to be `to.length + cc.length`, and
 * one address standing on BOTH lines — a mail sent to a list with the sender copied in, the most
 * ordinary shape there is — filled the quota by itself: two slots, one person. Reply all was
 * offered on a message that is 1:1 to this reader, and the envelope it built was the sender plus
 * that single other name, which is what plain Reply already sends. So the gate counts the folded
 * set across both lines, the same fold the envelope applies.
 */
export function replyAllRecipients(
  parent: { from: EmailAddress; to: readonly EmailAddress[]; cc?: readonly EmailAddress[] },
  ownAddresses: readonly string[],
): ReplyAllRecipients | null {
  const fold = (a: string): string => a.trim().toLowerCase();
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
 * ONE envelope for a reply — the computed audience, or the user's edit of it.
 *
 * The same discipline as `composePlan` and for the same reason: `InlineReply` judges the lock
 * with this and `AppShell.sendReply` builds the wire from it, so the head, the button and the
 * envelope cannot be three opinions.
 *
 * ── UNTOUCHED (`edit === null`) ──────────────────────────────────────────────────────────
 *
 * Exactly the derivation `sendReply` has always made: `replyAllRecipients` for a reply-all,
 * `replyRecipients` for the self-authored plain case, `null` otherwise so `Engine.enrich`
 * keeps deriving `[parent.from]`. **`bcc` is NEVER derived** — no reply of any kind
 * blind-copies anybody (`types.ts`), whatever the parent's recipient lists held. A blind
 * recipient exists only when somebody typed one.
 *
 * ── EDITED ───────────────────────────────────────────────────────────────────────────────
 *
 * The strings are parsed with the compose form's own parser and the compose form's own rule:
 * a typo in ANY row empties the whole envelope rather than sending the valid subset. The
 * emptied `to` is what `canSend` refuses — an edited reply always CARRIES its recipient set,
 * so "recipients present but empty" is expressible and refused, unlike the untouched path
 * where an absent `to` means "enrich decides".
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
 * Addresses → the one wire string the chip field edits — the PREFILL when a reply head opens.
 *
 * A display name rides along only when `parseRecipients` can read it back: the split is blind
 * to quoting, so a name containing a separator or an angle bracket ("Doe, John") would come
 * back as two broken entries. Such a name is dropped and the bare address kept — the envelope
 * is the address; the name is sugar the parent's headers still hold.
 *
 * The SAME rule and the same character class as `formatRecipient` (`@ohmail/client-engine`),
 * which is what accepting an address-book suggestion writes. That copy did not have the guard
 * until a suggestion named "Lindt, Nora" was found to disable Send; the two are kept
 * separate only because they take different inputs.
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
