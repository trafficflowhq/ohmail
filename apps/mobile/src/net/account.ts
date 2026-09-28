/**
 * WHAT THE ACCOUNT DOOR SAYS ABOUT THIS ACCOUNT — the two reads the wall and its strips need, and
 * the one press that mints the way back ({@link mintManageLink}).
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
  return {
    metered: true,
    ...(raw.access === "open" || raw.access === "refused" ? { access: raw.access } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(manageUrl ? { manageUrl } : {}),
    ...(exportPath ? { exportPath } : {}),
    ...(caughtUp ? { caughtUp } : {}),
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

/** The export's filename: dated, so two of them a month apart do not collide in a folder. */
export function exportFilename(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `ohmail-settings-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}
