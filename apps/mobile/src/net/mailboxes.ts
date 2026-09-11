import { faultDetail, refuse, type Refusal } from "../refusal";
import type { ConnectedSession } from "./pairing.js";

/**
 * The mailbox facts over the paired server — `GET /mailboxes`, the phone's first read of it.
 * The route is `cost: "read"` with no step-up and mounted on `localRoutes`, which all three
 * door tables spread, so one path serves ohmail Cloud, an operator's server and a desktop
 * host. `?counts=1` is deliberately not sent: it costs an aggregate over the whole `messages`
 * table, and the phone's own mirror answers every number it shows. Transport: `session.fetch`
 * only, bound to one origin — this file holds no origin of its own. `null` means "could not
 * ask", never "no mailboxes": an empty list is a real answer, and a caller reading them alike
 * would blank the banner and un-recognise the reader on every flaky request.
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
     * The route answers `{ items }`, and this read once named every shape but that one — so
     * every door's roster read returned `null` ("could not ask") and the two surfaces behind
     * it drew nothing: the Settings "This phone" panel (gated on `mailboxes.known`) and the
     * More screen's organizer banner. Built, shipped and unreachable — invisible here because
     * this file's own fixtures answered a bare array, the parser and its evidence agreeing
     * with each other; read on a device. All three shapes stay, and that is not indecision:
     * an envelope that grows a second name is a client reporting "no mailboxes" — a real
     * answer — rather than one that cannot ask.
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
 * The consent — `POST /mailboxes/:id/organize`, and on this phone the door already took it. A
 * mailbox nobody consented to organizing is read and nothing else — no claim, no `ohmail/*`
 * tree — and on the standalone door that left the phone reading its own mailbox for ever. The
 * fourth door's limitations screen states what this phone will do, and Continue on it is the
 * same statement the web's "Organize here" button takes — pressed here rather than on the
 * screen, because a relaunch adopts the same session with no screen in front of it. The empty
 * body `{}` is the whole request: the password is the engine's, sealed under this install's
 * key ring, and `screening` is the account's own — nothing on this door asked anybody for it.
 */
export type OrganizeOutcome =
  /** The consent is recorded and one organizing is authorized. The engine claims on its next cycle. */
  | { kind: "authorized" }
  /** This install already organizes it and consent is already recorded — a second press is not a second becoming. */
  | { kind: "already" }
  /**
   * ANOTHER INSTALL IS RENEWING ITS CLAIM, and the door refused. Nothing was written.
   *
   * Its own arm rather than a `refused` with a status in it, because it is the one refusal that is
   * not a fault: the mailbox is being organized, the panel already names the machine doing it, and
   * a sentence about a request that could not be made would be noise over a true state. `name` is
   * `""` where the claim named nothing — "named nobody" and "nobody holds it" are different facts
   * and the STATUS is what tells them apart, so an absent member here would collapse them.
   */
  | { kind: "held"; name: string; holderKind: string }
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
  /* ══ 409 IS ANOTHER INSTALL'S LIVE CLAIM, AND THE CLAIM THIS COMMENT MADE IS NOW TRUE ══════
   *
   * This block said "the route answers 409 where another install holds the mailbox" and the route
   * did not: `MailboxService.organizeHere` writes a stamp and leaves the decision to the gate,
   * which is right for a desktop — there the press is a person's finger and the 0.14.1 election is
   * meant to let them take a mailbox back from a machine they can no longer reach. Measured on a
   * phone, the same 202 answered a LAUNCH and moved a live laptop's mailbox onto a phone that
   * organizes only while it is open.
   *
   * The refusal is at the phone's own door now (`apps/sidecar/src/mobile.ts`), which is where it
   * belongs: this build has no takeover verb, so a live foreign holder is a 409 with the holder
   * named, whoever pressed. The holder rides the body because this door offers no other source
   * for it, and a malformed body is still a `held` — the STATUS is the fact and the name is the
   * detail. */
  if (res.status === 409) {
    const held = await res.json().then(
      (b) => (b as { holder?: { name?: unknown; kind?: unknown } }).holder,
      () => undefined,
    );
    return {
      kind: "held",
      name: typeof held?.name === "string" ? held.name : "",
      holderKind: typeof held?.kind === "string" ? held.kind : "",
    };
  }
  /* EVERY OTHER STATUS IS A REFUSAL WITH ITS NUMBER IN IT. 422 is an account that cannot take the
     mailbox and 503 is a row this install could not read; neither is a state this app can mend,
     and both are sentences a person can act on — which an Ohbox that never fills is not. */
  return { kind: "refused", reason: refuse("organizeHereRefused", res.status) };
}
