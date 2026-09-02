import type { ConnectedSession } from "./pairing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE MAILBOX FACTS OVER THE PAIRED SERVER — `GET /mailboxes`, the phone's first read of it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS MISSING, AND WHAT IT COST ────────────────────────────────────────────────────
 *
 * This client had NO mailbox read at all. Two surfaces said so in their own comments and both
 * were degraded by it (`state/live.ts`): `canReplyAll` could not tell the reader apart from
 * the other recipients, so it was offered from two listed people and withheld at one; and
 * `NO_OWN_ADDRESSES` — "recognise the reader nowhere" — was the honest posture for a surface
 * with no facts, with a note naming itself as the one place to feed. A third surface was
 * never built for the same reason: the onboarding deck has carried `phoneBanner` and
 * `phoneBannerWhy` with no consumer, because a banner naming who organizes the mailbox would
 * have been a claim with no source.
 *
 * ── IT IS REACHABLE ON ALL THREE DOORS, WHICH IS WHY THIS NEEDS NO BRANCH ──────────────────
 *
 * `GET /mailboxes` is `cost: "read"` with no step-up (`packages/api/src/routes/mailboxes.ts`),
 * and it is mounted on `localRoutes` — which the hosted table, `selfHostRoutes` AND
 * `desktopHostRoutes` all spread. So the same request answers whether the phone paired with
 * ohmail Cloud, an operator's server, or the ohmail app on somebody's computer, and this file
 * holds one path rather than three.
 *
 * `?counts=1` is deliberately NOT sent. It is the route's one opt-in and it costs an aggregate
 * over the whole `messages` table; nothing here renders a server-side count, and the phone's
 * own mirror already answers every number it shows.
 *
 * ── THE TRANSPORT RULE, VERBATIM FROM `consent.ts` AND `push.ts` ───────────────────────────
 *
 * `session.bearer.fetch` is the only transport, bound to ONE origin — the profile the user is
 * connected to. This file holds no origin of its own, so "the mailbox question goes to the
 * server you paired with, never anywhere else" is structural rather than reviewed.
 *
 * ── `null` MEANS "COULD NOT ASK", NEVER "NO MAILBOXES" ────────────────────────────────────
 *
 * The consent read's rule, and it matters more here: an empty list is a real answer (an
 * account whose mailbox was removed) and a transport failure is not. A caller that read them
 * alike would blank a banner and un-recognise the reader on every flaky request.
 */

/** One mailbox, reduced to the facts this phone can actually use. */
export interface PhoneMailbox {
  id: string;
  /** The mailbox's own address — what makes the reader recognisable in a To/Cc list. */
  address: string;
  /**
   * WHO ORGANIZES IT, when it is not the server this phone is paired with — `null` when that
   * server organizes it itself, and `null` when nobody ever has.
   *
   * Carried through from `MailboxDTO.organizedBy` UNCHANGED in that respect: the DTO is
   * explicit that the field is null when "this install does", and the phone must not turn that
   * into a name. `name` is the holder's own machine name and is the only part a person reads.
   */
  organizedBy: { kind: string | null; name: string | null } | null;
  /**
   * Whether that organizer is still renewing (`held`) or stopped and left its claim behind
   * (`stopped`); `null` is "the answering server has not looked", which is every organizer's
   * own row and every reader's row before its first cycle.
   */
  organizerState: "held" | "stopped" | null;
}

/** A `{kind,name}` holder, kept only when the wire really names one. */
function holderOf(raw: unknown): PhoneMailbox["organizedBy"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as { kind?: unknown; name?: unknown };
  const kind = typeof o.kind === "string" && o.kind !== "" ? o.kind : null;
  const name = typeof o.name === "string" && o.name !== "" ? o.name : null;
  /* AN OBJECT OF NULLS IS NOT A HOLDER. The DTO guarantees `organizedBy` is null as a WHOLE
     when nobody is named, and the webapp's derivation tests `kind || name` rather than the
     object for exactly this reason — a server that starts sending `{null,null,null}` must not
     put a banner over a mailbox with no holder. Same test, same reason, one client further. */
  return kind === null && name === null ? null : { kind, name };
}

/** `held`/`stopped`, or null for anything else — an unknown verdict is "has not looked". */
function stateOf(raw: unknown): PhoneMailbox["organizerState"] {
  return raw === "held" || raw === "stopped" ? raw : null;
}

/**
 * Read the account's mailboxes, or `null` for "could not ask".
 *
 * Rows with no usable `id`/`address` are dropped rather than kept as blanks: every consumer
 * here is either matching an address or naming a holder, and a row that can do neither is a
 * row that can only produce a wrong answer.
 */
export async function readMailboxes(session: ConnectedSession): Promise<PhoneMailbox[] | null> {
  try {
    const res = await session.bearer.fetch(`${session.profile.origin}/mailboxes`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as unknown;
    /* The route answers a bare array today. A future envelope (`{ mailboxes: [...] }`) is read
       too, because the alternative is a client that silently reports "no mailboxes" — which is
       a real answer here — the day the shape grows. Anything else is "could not ask". */
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { mailboxes?: unknown } | null)?.mailboxes)
        ? (body as { mailboxes: unknown[] }).mailboxes
        : null;
    if (rows === null) return null;
    const out: PhoneMailbox[] = [];
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "string" || r.id === "") continue;
      if (typeof r.address !== "string" || r.address === "") continue;
      out.push({
        id: r.id,
        address: r.address,
        organizedBy: holderOf(r.organizedBy),
        organizerState: stateOf(r.organizerState),
      });
    }
    return out;
  } catch {
    return null;
  }
}
