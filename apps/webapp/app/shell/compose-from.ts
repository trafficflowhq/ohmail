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
 *  · A reply keeps the mailbox the message arrived in (`Engine.enrich` → `parent.mailboxId`)
 *    and now SAYS so. If that mailbox can no longer send, the default is substituted and the
 *    substitution is stated on screen — never silently, and never by refusing the reply.
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

/** One mailbox, as a From line is entitled to know it. */
export interface FromOption {
  /** The selector's value. Never an address — see the header. */
  id: string;
  address: string;
  /** May this be the sender today? `status !== "disabled"`, matching `SendService.reserve`. */
  sendable: boolean;
  /** Healthy. The fresh-compose default prefers these. */
  connected: boolean;
}

/** The subset of {@link import("./mail-state").MailboxFacts} this module reads. */
interface FactsShape {
  id: string;
  address: string;
  status: string;
  createdAt: string;
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
    .map((m) => ({ id: m.id, address: m.address, sendable: true, connected: true }));
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
   * before this slice and is still the honest answer when nothing can be named.
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
}

const NOTHING: ResolvedFrom = {
  mailboxId: null,
  address: null,
  choices: [],
  substituted: false,
  substitutedFrom: null,
};

function resting(options: readonly FromOption[], chosen: FromOption | null): ResolvedFrom {
  return {
    mailboxId: chosen?.id ?? null,
    address: chosen?.address ?? null,
    choices: options.filter((o) => o.sendable),
    substituted: false,
    substitutedFrom: null,
  };
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
 */
export function resolveComposeFrom(
  options: readonly FromOption[],
  picked: string | null,
): ResolvedFrom {
  if (options.length === 0) return NOTHING;
  const kept = picked === null ? null : options.find((o) => o.id === picked && o.sendable) ?? null;
  return resting(options, kept ?? defaultFrom(options));
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
 */
export function resolveReplyFrom(
  options: readonly FromOption[],
  inherited: string | null,
): ResolvedFrom {
  if (options.length === 0) return NOTHING;
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
