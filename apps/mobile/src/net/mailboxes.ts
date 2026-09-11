import { faultDetail, refuse, type Refusal } from "../refusal";
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
 * `session.fetch` is the only transport, bound to ONE origin — the profile the user is
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
    const res = await session.fetch(`${session.profile.origin}/mailboxes`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as unknown;
    /**
     * ── THE ROUTE ANSWERS `{ items }`, AND THIS READ NAMED EVERY SHAPE BUT THAT ONE ───────────
     *
     * It read a bare array and `{ mailboxes }`, and the route has always answered
     * `jsonResponse({ items })`. So every door's roster read returned `null` — "could not ask" —
     * and the two surfaces behind it drew nothing at all: the Settings "This phone" panel, which
     * is gated on `mailboxes.known`, and the More screen's organizer banner. Built, shipped and
     * unreachable, and invisible here because this file's own fixtures answered a bare array —
     * the parser and its evidence agreeing with each other. Read on a device, where the panel
     * that names who organizes the mailbox never appeared.
     *
     * All three shapes stay, and that is not indecision: an envelope that grows a second name is
     * a client reporting "no mailboxes" — a real answer here — rather than one that cannot ask.
     */
    const envelope = body as { items?: unknown; mailboxes?: unknown } | null;
    const rows = Array.isArray(body)
      ? body
      : Array.isArray(envelope?.items)
        ? envelope.items
        : Array.isArray(envelope?.mailboxes)
          ? envelope.mailboxes
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

/**
 * HAND A MAILBOX BACK — `POST /mailboxes/:id/release`, the hosted route's local twin.
 *
 * 202 is the honest success: the claim lives in the customer's IMAP folder and the organizer's own
 * next pass is what expunges it, so this returns "asked for" and never "done". Anything else is a
 * refusal, and the caller keeps saying "Organizing" rather than a state nothing confirmed.
 *
 * No step-up, mirroring the route: this direction GIVES UP control, keeps every credential and
 * every message, and is reversible with the press beside it.
 */
export async function releaseMailbox(
  session: ConnectedSession,
  mailboxId: string,
): Promise<"requested" | "already" | "refused"> {
  try {
    const res = await session.fetch(
      `${session.profile.origin}/mailboxes/${encodeURIComponent(mailboxId)}/release`,
      { method: "POST" },
    );
    if (res.status === 202) return "requested";
    return res.status === 200 ? "already" : "refused";
  } catch {
    return "refused";
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CONSENT — `POST /mailboxes/:id/organize`, and on this phone the door already took it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A mailbox nobody has consented to organizing is READ and nothing else: the worker's gate never
 * claims it, `ensureFolders` never runs, and `ohmail/_meta` is never created. That is right — it is
 * what "connected, not organized" means on every door — and on the standalone door it left the
 * phone reading its own mailbox for ever, because the one client that could make this request is
 * the client bound to the engine, and until the standalone session existed there was none.
 *
 * ── WHY THE DOOR'S CONFIRM IS THE CONSENT, AND WHY THAT IS NOT AN ASSUMPTION ──────────────
 *
 * The fourth door's first step is the limitations screen, which states what this phone will do —
 * it organizes while the app is open or behind a notification, one mailbox, and the mail server
 * keeps everything — and a person reaches the password field only by pressing Continue on it. So
 * the confirm on that screen is the same statement the web's "Organize here" button takes, made
 * before any credential was typed. The press is made HERE rather than on the screen because a
 * relaunch adopts the same session with no screen in front of it, and a mailbox that is organized
 * only on the launch a person happened to press through is worse than one that is never organized.
 *
 * ── THE EMPTY BODY IS THE WHOLE REQUEST ───────────────────────────────────────────────────
 *
 * `{}`, deliberately: the password is the ENGINE's, sealed under this install's key ring, and the
 * route's optional `imap.pass` exists for a caller that has one to prove. Sending the one this app
 * does not hold would be inventing a credential; sending none takes the no-credential path, which
 * is the ordinary claim-back. `screening` is omitted for the same reason — the window is the
 * account's own and nothing on this door has asked anybody for it.
 */
export type OrganizeOutcome =
  /** The consent is recorded and one organizing is authorized. The engine claims on its next cycle. */
  | { kind: "authorized" }
  /** This install already organizes it and consent is already recorded — a second press is not a second becoming. */
  | { kind: "already" }
  /** Nothing was recorded, and the sentence says what the route answered. */
  | { kind: "refused"; reason: Refusal };

export async function organizeHere(
  session: ConnectedSession,
  mailboxId: string,
): Promise<OrganizeOutcome> {
  let res: Response;
  try {
    res = await session.fetch(
      `${session.profile.origin}/mailboxes/${encodeURIComponent(mailboxId)}/organize`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
  } catch (err) {
    /* The transport, quoted. On this door that is a call into this process, so a throw here is the
       engine's own and belongs in the sentence verbatim. */
    return { kind: "refused", reason: refuse("organizeHereUnreachable", faultDetail(err)) };
  }
  /* 202 IS THE ONLY AUTHORIZATION and 200 is the route's idempotent answer — see
     `MailboxTakeoverResult`. They are told apart because the second must never be reported as a
     fresh consent: a relaunch presses this every time, and "you are now organizing" on every
     launch is a sentence about an event that did not happen. */
  if (res.status === 202) return { kind: "authorized" };
  if (res.status === 200) {
    /**
     * TWO OUTCOMES SHARE THIS STATUS and only one of them is "already yours". `disconnected` means
     * the mailbox was turned off by the person, and reporting it as organizing would leave an
     * Ohbox that never fills behind a state the app called healthy.
     */
    let body: { outcome?: unknown };
    try {
      body = (await res.json()) as { outcome?: unknown };
    } catch {
      return { kind: "refused", reason: refuse("organizeHereUnreadable") };
    }
    if (body.outcome === "already_organizing") return { kind: "already" };
    return { kind: "refused", reason: refuse("organizeHereDisconnected") };
  }
  /* EVERY OTHER STATUS IS A REFUSAL WITH ITS NUMBER IN IT. The route answers 409 where another
     install holds the mailbox and 422 where the account cannot take it; neither is a state this
     app can mend, and both are sentences a person can act on — which an Ohbox that never fills
     is not. */
  return { kind: "refused", reason: refuse("organizeHereRefused", res.status) };
}
