/**
 * WHAT THE ACCOUNT DOOR SAYS ABOUT THIS ACCOUNT — the two reads the wall and its strips need.
 *
 * `GET /account/access` is the ONE fresh read (`routes/account.ts`): every other door keeps the
 * 60 s cache, so a strip that must see a reopening within seconds asks here. It sits on the
 * refusal allow-list, so a CLOSED account reaches it and gets the lifecycle, the manage link and
 * the export path back.
 *
 * `GET /account/export` is the settings document — rules, Screener decisions, the knobs a
 * self-hosted install reads when it takes this mailbox over. `cost: "read"`, no credentials, no
 * mail: the mailbox has the mail and always did.
 *
 * Neither is reachable on the standalone door, which has no plane — both answer `null` there
 * rather than inventing a state, and the caller draws nothing.
 */

import type { ConnectedSession } from "./pairing.js";
import { requestBase } from "./request-base";
import { lifecycleOf, type AccountLifecycle } from "./access-lock";

/** What `GET /account/access` said, reduced to what this phone draws. */
export interface AccountAccess {
  /** `false` is a host with no entitlements program at all — a self-hosted server. */
  metered: boolean;
  lifecycle?: AccountLifecycle;
  manageUrl?: string;
  exportPath?: string;
  /** The one-time catch-up after a reopening, keyed by `since` for its dismissal. */
  caughtUp?: { since: string; count: number };
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
  const c = raw.caughtUp as { since?: unknown; count?: unknown } | undefined;
  /* A catch-up needs BOTH halves to be a sentence: a count with no `since` has no date to name
     and no key to be dismissed by, and would come back at every launch. */
  const caughtUp =
    c && typeof c.since === "string" && c.since.length > 0
      && typeof c.count === "number" && Number.isFinite(c.count) && c.count >= 0
      ? { since: c.since, count: c.count }
      : undefined;
  return {
    metered: true,
    ...(lifecycle ? { lifecycle } : {}),
    ...(manageUrl ? { manageUrl } : {}),
    ...(exportPath ? { exportPath } : {}),
    ...(caughtUp ? { caughtUp } : {}),
  };
}

/**
 * Ask the door. `null` is "could not ask" — never "nothing to say": a strip drawn from a failed
 * read would appear and vanish with the network, and a wall raised from one would be a wall over
 * a flaky minute.
 */
export async function readAccess(session: ConnectedSession): Promise<AccountAccess | null> {
  if (session.standalone) return null;
  try {
    const res = await session.fetch(`${requestBase(session)}/account/access`, { method: "GET" });
    if (res.status !== 200) return null;
    return accessOf((await res.json()) as unknown);
  } catch {
    return null;
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

/** The export's filename: dated, so two of them a month apart do not collide in a folder. */
export function exportFilename(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `ohmail-settings-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}
