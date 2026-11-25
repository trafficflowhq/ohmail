/**
 * WHAT A MAILBOX'S ROW SAYS, decided once over its facts, as the shipped pane decided it: its state, why a failing
 * one fails, who organizes it and what may be done about that, and the quiet facts beside. Pure over a translator,
 * so every arm is driven by a test; the drawing only places what this answers.
 */
import {
  claimLeftBehind,
  filerKey,
  isSyncBlockReason,
  readerHolderLapsed,
  readerStandDown,
  showInboundQuiet,
  standDownKey,
  type ReaderStandDown,
} from "../../mail-state/mail-state.js";
import { mailboxErrorKey } from "../../mail-state/mailbox-error-key.js";
import { appPasswordPresetFor, providerById } from "../connect/providers.js";
import type { PaneSaid } from "./organizer.js";
import { mailboxCheckedAt } from "./rows.js";
import type { Stamps } from "./stamps.js";
import type { MailboxRow } from "./types.js";

/** A sentence, said. */
export type Say = (said: PaneSaid) => string;

export interface RowContext {
  readonly now: number;
  readonly stamps: Stamps;
  readonly say: Say;
  /** A count as the reader's language writes it. */
  readonly figure: (n: number) => string;
  readonly filer: "cloud" | "server";
  /** This mailbox's re-sync was pressed and the server has not been given it yet. */
  readonly queued: boolean;
  /** The account's mirror is growing and this is its one live mailbox. */
  readonly importingSole: boolean;
}

/** The row's state: what is strictly this mailbox's, in the order that lets nothing outvote a fault. */
export type RowState =
  | { readonly kind: "none" }
  | { readonly kind: "erasing"; readonly text: string }
  | { readonly kind: "bad"; readonly text: string; readonly title?: string }
  | { readonly kind: "wait"; readonly text: string }
  | { readonly kind: "calm"; readonly text: string; readonly title?: string }
  | { readonly kind: "ok"; readonly text: string; readonly title: string };

/** Signs in with a Google App Password: its stored preset, else its address. */
export function signsInWithAppPassword(m: Pick<MailboxRow, "provider" | "address">): boolean {
  return providerById(m.provider).authHints === true || appPasswordPresetFor(m.address)?.authHints === true;
}

/** The provider's label: a brand's own name, or `null` where the catalogue says it (the generic entry). */
export function providerName(m: Pick<MailboxRow, "provider">): string | null {
  const p = providerById(m.provider);
  return p.manual ? null : p.label;
}

/** The service is not fetching this mailbox's new mail, and nothing else is wrong with it. */
export function notCheckedOf(m: MailboxRow, ctx: Pick<RowContext, "now" | "stamps">) {
  const on = m.fetching?.behind === true && !m.erasure && m.status === "connected" && !m.syncBlockedSince;
  const since = on && m.fetching?.since ? ctx.stamps.when(m.fetching.since, ctx.now) : "";
  return { on, values: { hasSince: since === "" ? "no" : "yes", since } };
}

/** The time and attempt count for a failing mailbox, separate from its human-readable reason. */
function errorTitle(m: MailboxRow, ctx: RowContext): string | undefined {
  const parts: string[] = [];
  const since = m.failedAt ?? m.unreachableSince ?? m.syncBlockedSince;
  if (since) parts.push(ctx.say({ key: "errSince", values: { when: ctx.stamps.ago(since, ctx.now).abs } }));
  if (m.retryCount && m.retryCount > 1)
    parts.push(ctx.say({ key: "errAttempts", values: { count: m.retryCount } }));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function rowStateOf(m: MailboxRow, ctx: RowContext): RowState {
  if (m.erasure)
    return { kind: "erasing", text: ctx.say({ key: "erasingLeft", values: { count: m.erasure.remaining } }) };
  if (m.status === "disabled") return { kind: "none" };
  if (m.status === "error" || m.unreachableSince) {
    const err = mailboxErrorKey(
      m.errorCode ?? (m.unreachableSince ? "connect" : null),
      m.errorDetail,
      m.storeRefusals,
      (r) =>
        r.exact
          ? ctx.figure(r.count)
          : ctx.say({ key: "storeRefusalsFloor", values: { count: ctx.figure(r.count) } }),
      m.errorLocalServer,
      { appPassword: signsInWithAppPassword(m) },
    );
    const title = errorTitle(m, ctx);
    return {
      kind: "bad",
      text: ctx.say({ key: err.key, ...(err.values ? { values: err.values } : {}) }),
      ...(title ? { title } : {}),
    };
  }
  if (m.syncBlockedSince) {
    const key = isSyncBlockReason(m.syncBlockedReason) ? `blocked_${m.syncBlockedReason}` : "blockedUnknown";
    return { kind: "bad", text: ctx.say({ ns: "sync", key }), title: errorTitle(m, ctx) };
  }
  if (ctx.queued) return { kind: "wait", text: ctx.say({ key: "syncQueued" }) };
  const late = notCheckedOf(m, ctx);
  if (late.on) {
    const title = m.fetching?.since ? ctx.stamps.ago(m.fetching.since, ctx.now).abs : undefined;
    return {
      kind: "calm",
      text: ctx.say({ key: "notChecked", values: late.values }),
      ...(title ? { title } : {}),
    };
  }
  if (ctx.importingSole) return { kind: "wait", text: ctx.say({ key: "syncRunning" }) };
  const checkedAt = mailboxCheckedAt(m);
  if (!checkedAt) {
    const when = m.createdAt ? ctx.stamps.ago(m.createdAt, ctx.now).rel : ctx.stamps.justNow;
    return { kind: "wait", text: ctx.say({ key: "syncFirstPending", values: { when } }) };
  }
  const stamp = ctx.stamps.ago(checkedAt, ctx.now);
  return {
    kind: "ok",
    text: ctx.say({
      key: "syncedAgo",
      values: { when: ctx.stamps.when(checkedAt, ctx.now) || stamp.abs },
    }),
    title: stamp.abs,
  };
}

/** Who holds the mailbox, and which remedy the row offers: one per row, never two in opposite directions. */
export interface Standing {
  readonly standDown: ReaderStandDown | null;
  /** This install's own claim is left on a mailbox the row says somebody else holds: hand it back. */
  readonly stranded: boolean;
  /** The holder named stopped renewing its claim: it is nobody. */
  readonly lapsed: boolean;
  /** This install organizes it (or holds a claim left behind), with the person's consent: the organizer block. */
  readonly organizerBlock: boolean;
}

export function standingOf(m: MailboxRow): Standing {
  const standDown = readerStandDown(m);
  const stranded = claimLeftBehind(m);
  const lapsed =
    standDown !== null && standDown !== "released" && standDown !== "parked" && readerHolderLapsed(m);
  const organizerBlock =
    ((standDown === null && m.organizerRole !== "reader") || stranded) &&
    m.status === "connected" &&
    Boolean(m.organizeConsentedAt);
  return { standDown, stranded, lapsed, organizerBlock };
}

/** The stand-down's sentence: who holds it now, or that nothing does. */
export function standDownSaid(s: Standing, filer: "cloud" | "server"): PaneSaid | null {
  if (s.standDown === null || s.standDown === "released" || s.standDown === "parked" || s.stranded)
    return null;
  return { key: s.lapsed ? "standDownLapsed" : standDownKey(s.standDown, filer) };
}

/** The organizer block's description: a claim left behind, a refused stop, a stop on its way, or organizing. */
export function organizingSaid(m: MailboxRow, s: Standing, filer: "cloud" | "server"): PaneSaid {
  if (s.stranded) return { key: filerKey("claimLeftBehind", filer) };
  if (m.releaseRequestedAt)
    return {
      key: m.releaseRefusal === "sibling_lapse" ? filerKey("siblingLapse", filer) : "stopOrganizingPending",
    };
  return { key: filerKey("organizing", filer) };
}

/** The forwarding notice: a quiet, healthy mailbox, said once per episode until the person says they know. */
export function quietSaid(m: MailboxRow, ctx: Pick<RowContext, "now" | "stamps">): PaneSaid | null {
  if (!showInboundQuiet(m, ctx.now)) return null;
  if (m.createdAt && m.inboundQuietSince === m.createdAt) return { key: "inboundQuietNever" };
  return { key: "inboundQuiet", values: { when: ctx.stamps.ago(m.inboundQuietSince!, ctx.now).rel } };
}
