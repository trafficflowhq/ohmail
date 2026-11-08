/**
 * WHAT THE ACCOUNT DOOR SAYS ABOUT THIS ACCOUNT — the two reads the wall and its strips need, and
 * the one press that mints the way back ({@link mintManageLink}); and the storage doors: the
 * person's storage choices ({@link setStorageChoice}) and an emptied letter's text for one view
 * ({@link loadLiveBody}).
 * `GET /account/access` is the ONE fresh read: every other door keeps the 60 s cache, so a strip
 * that must see a reopening within seconds asks here, and it is on the refusal allow-list, so a
 * CLOSED account reaches it. `GET /account/export` is the settings document — rules, Screener
 * decisions, the knobs a self-hosted install reads when it takes this mailbox over; no mail.
 * Neither is reachable on the standalone door, which has no plane: both answer `null` there
 * rather than inventing a state, and the caller draws nothing.
 */

import type { ConnectedSession } from "./pairing.js";
import { requestBase } from "./request-base";
import {
  closeStaleWindow, liftAccessLock, lifecycleOf, raiseAccessLock,
  type AccessRefusedFacts, type AccountLifecycle,
} from "./access-lock";
import { recordVerdict } from "../state/access-verdict";
import { RETURN_DEBOUNCE_MS } from "../ui/wall-lift";

/** What `GET /account/access` said, reduced to what this phone draws. */
export interface AccountAccess {
  /** `false` is a host with no entitlements program at all — a self-hosted server. */
  metered: boolean;
  /**
   * The gate's own verdict in a word. ABSENT on an API that predates it, and absent is never
   * read as open: an older server's wall still comes down only by signing in again.
   */
  access?: "open" | "refused";
  lifecycle?: AccountLifecycle;
  manageUrl?: string;
  exportPath?: string;
  /** The one-time catch-up after a reopening, keyed by `since` for its dismissal. */
  caughtUp?: { since: string };
  /** Stored letter text against the plan's cap: a metered account with a cap, on a server that says. */
  storage?: StorageFacts;
}

/**
 * `GET /account/access`'s storage block. When stored text reaches the cap, ohmail empties the text of
 * the oldest letters; they stay complete on the mail server. `keptFrom` is "YYYY-MM": text is kept for
 * letters from that month on, but for the `withheldOnArrival` letters: of `emptiedForSpace`, those
 * stored without their text because they arrived while the storage was full.
 */
export interface StorageFacts {
  usedBytes: number;
  limitBytes: number;
  emptiedForSpace: number;
  firstEmptiedAt: string | null;
  keptFrom: string | null;
  withheldOnArrival: number;
  /** What adds room: a bigger plan, or (on the largest plan) the storage add-on alone. */
  upgrade: "plan" | "addon";
  /** The server's word: is the current cap what empties text now? */
  emptyingNow: boolean;
  /** Inside the trial's storage floor: the plan's own, lower limit, else `null`. */
  planLimitBytes: number | null;
  /** When the plan's limit applies again (ISO); `null` until a first payment dates it. */
  limitDropsAt: string | null;
  /** Why the cap is what it is: the plan's own, the trial's room above it, or a lower limit held; null from an older server. */
  limitReason: StorageLimitReason | null;
  /** A mailbox is still on its first import. */
  importing: boolean;
  /**
   * The card the server decided for the Ohbox, the person's dismissal applied; `undefined` from an
   * older server, which decides none: the phone decides it then (`storageLevelOf`).
   */
  card: StorageCardLevel | null | undefined;
  /** Storage mails are on; null from an older server. */
  mail: boolean | null;
  estimate: StorageEstimate | null;
  /** Per mailbox, by id. */
  mailboxes: StorageMailboxShare[];
  /** The program's offer, narrowed to rooms and names: this phone reads no price. */
  offer: StorageOfferFacts | null;
}

export type StorageCardLevel = "near" | "full" | "drop";
export type StorageLimitReason = "plan" | "trial" | "held";
export type StoragePlanName = "solo" | "plus" | "pro";

export interface StorageEstimate {
  expectedBytes: number;
  expectedLetters: number;
  storedLetters: number;
  avgLetterBytes: number;
  /** False while the folders still have no count: the estimate grows as they are opened. */
  complete: boolean;
}

export interface StorageMailboxShare {
  id: string;
  usedBytes: number;
  expectedBytes: number;
  importing: boolean;
}

export interface StorageOfferFacts {
  plans: { plan: StoragePlanName; roomBytes: number }[];
  addon: { unitBytes: number; maxUnits: number } | null;
  current: { plan: StoragePlanName; addonUnits: number; roomBytes: number };
  fit: { plan: StoragePlanName; addonUnits: number; roomBytes: number; keepsAll: boolean };
}

const count = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

const record = (v: unknown): Record<string, unknown> | null =>
  (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const planName = (v: unknown): StoragePlanName | null => (v === "solo" || v === "plus" || v === "pro" ? v : null);

function estimateOf(raw: unknown): StorageEstimate | null {
  const r = record(raw);
  if (r === null) return null;
  const expectedBytes = count(r.expectedBytes);
  const expectedLetters = count(r.expectedLetters);
  const storedLetters = count(r.storedLetters);
  const avgLetterBytes = count(r.avgLetterBytes);
  if (expectedBytes === null || expectedLetters === null || storedLetters === null || avgLetterBytes === null) return null;
  return { expectedBytes, expectedLetters, storedLetters, avgLetterBytes, complete: r.complete !== false };
}

function mailboxSharesOf(raw: unknown): StorageMailboxShare[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = record(m);
    const usedBytes = count(r?.usedBytes);
    const expectedBytes = count(r?.expectedBytes);
    if (r === null || typeof r.id !== "string" || usedBytes === null || expectedBytes === null) return [];
    return [{ id: r.id, usedBytes, expectedBytes, importing: r.importing === true }];
  });
}

/** The offer's rooms and names, nothing else: an amount or a currency never enters this phone. */
function offerOf(raw: unknown): StorageOfferFacts | null {
  const r = record(raw);
  if (r === null || r.canChange !== true) return null;
  const plans = (Array.isArray(r.plans) ? r.plans : []).flatMap((p) => {
    const plan = planName(record(p)?.plan);
    const roomBytes = count(record(p)?.roomBytes);
    return plan !== null && roomBytes !== null && roomBytes > 0 ? [{ plan, roomBytes }] : [];
  });
  const a = record(r.addon);
  const unitBytes = count(a?.unitBytes);
  const maxUnits = count(a?.maxUnits);
  const c = record(r.current);
  const f = record(r.fit);
  const current = c && planName(c.plan) !== null && count(c.roomBytes) !== null
    ? { plan: planName(c.plan)!, addonUnits: count(c.addonUnits) ?? 0, roomBytes: count(c.roomBytes)! } : null;
  const fit = f && planName(f.plan) !== null && count(f.roomBytes) !== null
    ? { plan: planName(f.plan)!, addonUnits: count(f.addonUnits) ?? 0, roomBytes: count(f.roomBytes)!, keepsAll: f.keepsAll === true }
    : null;
  if (plans.length === 0 || current === null || fit === null) return null;
  return {
    plans, current, fit,
    addon: unitBytes !== null && unitBytes > 0 && maxUnits !== null && maxUnits > 0 ? { unitBytes, maxUnits } : null,
  };
}

/** Narrow the block; an absent or malformed one is none, never "0 of 0". */
export function storageOf(raw: unknown): StorageFacts | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const usedBytes = count(r.usedBytes);
  const limitBytes = count(r.limitBytes);
  const emptiedForSpace = count(r.emptiedForSpace);
  if (usedBytes === null || limitBytes === null || limitBytes <= 0 || emptiedForSpace === null) return null;
  const plan = count(r.planLimitBytes);
  const planLimitBytes = plan !== null && plan > 0 && plan < limitBytes ? plan : null;
  return {
    usedBytes, limitBytes, emptiedForSpace,
    firstEmptiedAt: str(r.firstEmptiedAt) ?? null,
    keptFrom: typeof r.keptFrom === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.keptFrom) ? r.keptFrom : null,
    // An older server sends none; never more than the letters emptied.
    withheldOnArrival: Math.min(count(r.withheldOnArrival) ?? 0, emptiedForSpace),
    // An older server names none: a bigger plan, as it said before.
    upgrade: r.upgrade === "addon" ? "addon" : "plan",
    // An older server does not say: only at the cap.
    emptyingNow: typeof r.emptyingNow === "boolean" ? r.emptyingNow : usedBytes >= limitBytes,
    planLimitBytes,
    limitDropsAt: planLimitBytes !== null && typeof r.limitDropsAt === "string" && Number.isFinite(Date.parse(r.limitDropsAt))
      ? r.limitDropsAt : null,
    limitReason: r.limitReason === "plan" || r.limitReason === "trial" || r.limitReason === "held" ? r.limitReason : null,
    importing: r.importing === true,
    card: r.card === undefined ? undefined : r.card === "near" || r.card === "full" || r.card === "drop" ? r.card : null,
    mail: typeof r.mail === "boolean" ? r.mail : null,
    estimate: estimateOf(r.estimate),
    mailboxes: mailboxSharesOf(r.mailboxes),
    offer: offerOf(r.offer),
  };
}

const str = (v: unknown): string | undefined =>
  (typeof v === "string" && v.length > 0 ? v : undefined);

/** Narrow the body. Everything optional, because every field is absent on some real server. */
export function accessOf(body: unknown): AccountAccess | null {
  if (body === null || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (raw.metered !== true) return { metered: false };
  const lifecycle = lifecycleOf(raw.lifecycle);
  const manageUrl = str(raw.manageUrl);
  const exportPath =
    typeof raw.exportPath === "string" && raw.exportPath.startsWith("/") ? raw.exportPath : undefined;
  const c = raw.caughtUp as { since?: unknown } | undefined;
  /* The date is the catch-up: without `since` there is no sentence and no key to dismiss it by. An
     older API's count is dropped (mail 0135) — it counted the closure's mail, not the catch-up. */
  const caughtUp = c && typeof c.since === "string" && c.since.length > 0 ? { since: c.since } : undefined;
  const storage = storageOf(raw.storage);
  return {
    metered: true,
    ...(raw.access === "open" || raw.access === "refused" ? { access: raw.access } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(manageUrl ? { manageUrl } : {}),
    ...(exportPath ? { exportPath } : {}),
    ...(caughtUp ? { caughtUp } : {}),
    ...(storage ? { storage } : {}),
  };
}

/** The one predicate the wall lifts on: the service's own `access: "open"`, and nothing else. */
export function opensTheWall(a: AccountAccess): boolean {
  return a.metered && a.access === "open";
}

/** The wall's facts from a refused answer — the same fields the 402 carries — or `null`. */
export function refusedFactsOf(a: AccountAccess): AccessRefusedFacts | null {
  if (!a.metered || a.access !== "refused") return null;
  const lifecycle = a.lifecycle;
  // Wire words, never shown: an operator hold, or the arm whose remedy is a door to act on.
  const reason: AccessRefusedFacts["reason"] =
    lifecycle?.closedReason === "suspended" ? "suspended" : "payment_required";
  return {
    reason,
    ...(a.manageUrl ? { manageUrl: a.manageUrl } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(a.exportPath ? { exportPath: a.exportPath } : {}),
  };
}

/**
 * THE ACCESS FEED — the latest answer per pairing, whoever asked for it (the first-paint gate, the
 * wall's lift, the strip), so the strip follows every one. It holds the one-time catch-up until it
 * is put away, because the service answers that once, to whichever read asks first; module state,
 * with its bound in `ui/lifecycle-strip.ts`. Forgetting the pairing forgets its entry.
 */
export interface AccessFeed {
  answer: AccountAccess;
  caughtUp: { since: string } | null;
  /** When this answer arrived. */
  at: number;
}

const feeds = new Map<string, AccessFeed>();
const heldCatchUps = new Map<string, string>();
const feedListeners = new Set<() => void>();
const tellFeed = (): void => { for (const listener of [...feedListeners]) listener(); };

function publishAccess(profileId: string, a: AccountAccess): void {
  if (a.metered && a.caughtUp !== undefined) heldCatchUps.set(profileId, a.caughtUp.since);
  const since = heldCatchUps.get(profileId);
  feeds.set(profileId, { answer: a, caughtUp: since === undefined ? null : { since }, at: Date.now() });
  tellFeed();
}

/** This pairing's feed, or `null` — the stored reference, so a snapshot is stable. */
export function accessFeedFor(profileId: string): AccessFeed | null {
  return feeds.get(profileId) ?? null;
}

export function onAccessFeed(listener: () => void): () => void {
  feedListeners.add(listener);
  return () => { feedListeners.delete(listener); };
}

/** The catch-up was put away: gone from the feed, never said twice. */
export function putAwayCatchUp(profileId: string): void {
  heldCatchUps.delete(profileId);
  const entry = feeds.get(profileId);
  if (entry !== undefined && entry.caughtUp !== null) {
    feeds.set(profileId, { ...entry, caughtUp: null });
    tellFeed();
  }
}

/** The pairing is forgotten: nothing it was answered is kept. */
export function forgetAccessFeed(profileId: string): void {
  heldCatchUps.delete(profileId);
  if (feeds.delete(profileId)) tellFeed();
}

/** Tests only. */
export function resetAccessFeedForTests(): void {
  feeds.clear();
  heldCatchUps.clear();
  putAwayThisRun.clear();
}

/**
 * EVERY ANSWER IS THE SERVICE'S FRESH WORD: published to the feed, an open one lifts the wall and
 * opens the stale-402 window, a refused one raises the wall like a 402 would, and both are kept
 * for the next launch's first paint. An answer with no `access` changes no verdict.
 */
function noteAccess(session: ConnectedSession, a: AccountAccess): void {
  publishAccess(session.profile.id, a);
  if (!a.metered) { recordVerdict(session.profile.id, "open"); return; }
  if (opensTheWall(a)) {
    recordVerdict(session.profile.id, "open");
    liftAccessLock();
    return;
  }
  const facts = refusedFactsOf(a);
  if (facts === null) return;
  recordVerdict(session.profile.id, "closed");
  closeStaleWindow();
  raiseAccessLock(facts);
}

/**
 * Ask the door. `null` is "could not ask" — never "nothing to say": a strip drawn from a failed
 * read would appear and vanish with the network, and a wall raised from one would be a wall over
 * a flaky minute. A read asked inside {@link RETURN_DEBOUNCE_MS} of the last one for this session
 * joins it: the wall and the strip both ask on the same return to the foreground. A failed read
 * is not joined.
 */
const asked = new WeakMap<ConnectedSession, { at: number; answer: Promise<AccountAccess | null> }>();

export function readAccess(session: ConnectedSession): Promise<AccountAccess | null> {
  if (session.standalone) return Promise.resolve(null);
  const held = asked.get(session);
  if (held !== undefined && Date.now() - held.at < RETURN_DEBOUNCE_MS) return held.answer;
  const entry = { at: Date.now(), answer: askAccess(session) };
  asked.set(session, entry);
  void entry.answer.then((a) => { if (a === null && asked.get(session) === entry) asked.delete(session); });
  return entry.answer;
}

async function askAccess(session: ConnectedSession): Promise<AccountAccess | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/account/access`, { method: "GET" });
    if (res.status !== 200) return null;
    const a = accessOf((await res.json()) as unknown);
    if (a !== null) noteAccess(session, a);
    return a;
  } catch {
    return null;
  }
}

/** What a press on the way back got: the page to open, or why there is none. */
export type ManageLink =
  | { kind: "url"; url: string }
  /** `403 email_unverified` — the account page needs a confirmed address, said by name. */
  | { kind: "unverified" }
  | { kind: "failed" };

/**
 * MINT THE ACCOUNT-PAGE LINK AT THE PRESS — `POST /account/manage-link` with the app's language.
 * A link lives ten minutes and once, so none is ever kept: `manageUrl` on a 402 or an access
 * read only decides whether the button is drawn. Only an https answer is a page to open.
 */
export async function mintManageLink(
  session: ConnectedSession,
  lang: "de" | "en",
): Promise<ManageLink> {
  if (session.standalone) return { kind: "failed" };
  try {
    const res = await session.fetch(`${requestBase(session)}/account/manage-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang }),
    });
    const body = (await res.json().catch(() => null)) as
      { url?: unknown; error?: { code?: unknown } } | null;
    if (res.status === 403 && body?.error?.code === "email_unverified") return { kind: "unverified" };
    const url = res.status === 200 ? body?.url : undefined;
    return typeof url === "string" && url.startsWith("https://") ? { kind: "url", url } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/** An older server keeps no dismissal: this run does, per pairing, level and cap. */
const putAwayThisRun = new Set<string>();

const putAwayKey = (profileId: string, level: StorageCardLevel, cap: string) => `${profileId}.${level}.${cap}`;

/** The cap an older server's card is put away under: a new cap, plan limit or date brings it back. */
export function storageCardCap(f: StorageFacts): string {
  return `${f.limitBytes}.${f.planLimitBytes ?? ""}.${f.limitDropsAt ?? ""}`;
}

/** Did this run put an older server's card away at `level` under `cap`, for this pairing? */
export function storagePutAwayOf(profileId: string): (level: StorageCardLevel, cap: string) => boolean {
  return (level, cap) => putAwayThisRun.has(putAwayKey(profileId, level, cap));
}

/** A storage choice the server keeps per account (`PATCH /account/storage`): hide a card, or the storage mails on or off. */
export type StorageChoice = { dismiss: StorageCardLevel } | { mail: boolean };

/**
 * Tell the server, then show its effect on this pairing's feed at once (the card gone, the switch
 * moved) rather than after the next read. `false` is any failure: nothing is changed here.
 */
export async function setStorageChoice(session: ConnectedSession, choice: StorageChoice): Promise<boolean> {
  if (session.standalone) return false;
  const held = feeds.get(session.profile.id);
  const facts = held?.answer.storage;
  if ("dismiss" in choice && held !== undefined && facts !== undefined && facts.card === undefined) {
    putAwayThisRun.add(putAwayKey(session.profile.id, choice.dismiss, storageCardCap(facts)));
    feeds.set(session.profile.id, { ...held });
    tellFeed();
    return true;
  }
  try {
    const res = await session.fetch(`${requestBase(session)}/account/storage`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(choice),
    });
    if (res.status !== 200) return false;
  } catch {
    return false;
  }
  const entry = feeds.get(session.profile.id);
  const storage = entry?.answer.storage;
  if (entry !== undefined && storage !== undefined) {
    const next = "dismiss" in choice ? { ...storage, card: null } : { ...storage, mail: choice.mail };
    feeds.set(session.profile.id, { ...entry, answer: { ...entry.answer, storage: next } });
    tellFeed();
  }
  return true;
}

/** LOAD IT NOW's answer: the letter's text for this view, or why there is none. */
export type LiveBodyAnswer =
  | { kind: "text"; text: string }
  /** 410: the mail server no longer holds it where ohmail last saw it. */
  | { kind: "gone" }
  /** 413: over the size the server loads. */
  | { kind: "too_large" }
  /** 429: the hour's loads are spent. */
  | { kind: "busy" }
  | { kind: "failed" };

/**
 * `GET /messages/:id/live-body` — the text of a letter emptied for space, read from the mail server
 * for one view. The answer is handed back and kept nowhere: no store, no mirror, no cache.
 */
export async function loadLiveBody(session: ConnectedSession, messageId: string): Promise<LiveBodyAnswer> {
  try {
    const res = await session.fetch(
      `${requestBase(session)}/messages/${encodeURIComponent(messageId)}/live-body`, { method: "GET" },
    );
    if (res.status === 410) return { kind: "gone" };
    if (res.status === 413) return { kind: "too_large" };
    if (res.status === 429) return { kind: "busy" };
    if (res.status !== 200) return { kind: "failed" };
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    return typeof body?.text === "string" ? { kind: "text", text: body.text } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * The settings document, as the text a file is written from. `null` is any failure at all — the
 * screen says so rather than handing somebody an empty file and calling it their settings.
 *
 * The path comes from the SERVER (`exportPath`), not from a literal here: a door this client
 * spelled itself would be a second spelling of one route, and the 402's own body names it.
 */
export async function readExport(
  session: ConnectedSession,
  path: string,
): Promise<string | null> {
  if (session.standalone) return null;
  if (!path.startsWith("/")) return null;
  try {
    const res = await session.fetch(`${requestBase(session)}${path}`, { method: "GET" });
    if (res.status !== 200) return null;
    const text = await res.text();
    /* It must PARSE before it is offered as somebody's settings: an HTML error page saved under
       a `.json` name is a file that looks like an export and restores nothing. */
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

/**
 * WHERE THE SELF-HOSTING GUIDE IS — the address the wall offers after somebody has their
 * settings file, and the SAME one the browser's wall and the download page send people to
 * (`apps/webapp/app/(product)/mailbox/AccessLock.tsx`). Two surfaces, one address: a second
 * spelling is how one of them quietly rots.
 *
 * It lives HERE rather than on the screen because this file is inside the phone's network seam,
 * which is the one place an address may be written down (`test/privacy.test.ts`). Nothing dials
 * it — the system browser does, on a press.
 */
export const SELF_HOST_GUIDE =
  "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/README.md";

/**
 * THE OPERATOR'S PAGES the phone names in Settings and on the wall, written down here for the reason
 * above; the system browser opens them on a press. The deletion page is deletion-only: it has no
 * path to a plan, so a store build may offer it (App Review 5.1.1(v), Play's deletion rule).
 */
export const PRIVACY_URL = "https://ohmail.app/privacy";
export const IMPRINT_URL = "https://ohmail.app/imprint";
export const SUPPORT_URL = "https://ohmail.app/support";
export const DELETE_ACCOUNT_URL = "https://ohmail.app/delete-account";

/** The export's filename: dated, so two of them a month apart do not collide in a folder. */
export function exportFilename(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `ohmail-settings-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}
