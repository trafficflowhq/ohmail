import type { ConnectedSession } from "./pairing.js";
/* THE ONE BASE EVERY REQUEST IS COMPOSED OFF — see `request-base.ts`. */
import { requestBase } from "./request-base";

/**
 * What the Screener filed on its own, and putting it back — `GET /screener/auto-filed` and
 * `POST /screener/auto-filed/undo`, the web Settings row's route pair (row 140). Both routes are in
 * `localRoutes`, so the standalone door this phone opens on itself serves them too. A read that
 * could not be made answers `null`, never an empty list, which would say nothing was filed.
 */

export interface AutoFiledItem {
  messageId: string;
  from: string | null;
  subject: string | null;
  /** The pile the pass filed it to. */
  to: string;
  /** When, ISO; `null` from a server that does not say. */
  filedAt: string | null;
  /** `impersonation`: it claimed a company it cannot be from (`brand`), filed to Spam with no AI. */
  why: "impersonation" | null;
  brand: string | null;
}

export interface AutoFiledPage { items: AutoFiledItem[]; more: boolean }

/** What a Put back did: put back here, or sent to the install that organizes the mailbox. */
export type PutBackAnswer = { putBack: string[]; requested: string[] } | null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function readAutoFiled(session: ConnectedSession): Promise<AutoFiledPage | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/screener/auto-filed`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { items?: unknown; more?: unknown } | null;
    if (body === null || !Array.isArray(body.items)) return null;
    const items = body.items.flatMap((raw): AutoFiledItem[] => {
      const r = raw as Record<string, unknown>;
      const messageId = str(r.messageId);
      const to = str(r.to);
      const claim = r.why === "impersonation";
      return messageId === null || to === null ? [] : [{
        messageId, to, from: str(r.from), subject: str(r.subject), filedAt: str(r.filedAt),
        why: claim ? "impersonation" as const : null, brand: claim ? str(r.brand) : null,
      }];
    });
    return { items, more: body.more === true };
  } catch {
    return null;
  }
}

export async function putBackAutoFiled(session: ConnectedSession, messageIds: readonly string[]): Promise<PutBackAnswer> {
  try {
    const res = await session.fetch(`${requestBase(session)}/screener/auto-filed/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIds: [...messageIds] }),
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { putBack?: unknown; requested?: unknown };
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { putBack: ids(body.putBack), requested: ids(body.requested) };
  } catch {
    return null;
  }
}

/**
 * FILING A HELD IMPERSONATION TO SPAM — `GET`/`PATCH /account/screening`'s `impersonationFiling`, the
 * web Settings switch's door. `null`: the read or the save could not be made, or the server does not
 * know the switch; a surface then offers no control rather than a guessed one.
 */
export async function readImpersonationFiling(session: ConnectedSession): Promise<boolean | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/account/screening`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { impersonationFiling?: unknown } | null;
    return typeof body?.impersonationFiling === "boolean" ? body.impersonationFiling : null;
  } catch {
    return null;
  }
}

/** The switch written; answers the value the server now holds, or `null` when it did not save. */
export async function saveImpersonationFiling(session: ConnectedSession, on: boolean): Promise<boolean | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/account/screening`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ impersonationFiling: on }),
    });
    // 202: sent to the install that organizes the mailbox; it applies the change there.
    if (res.status !== 200 && res.status !== 202) return null;
    const body = (await res.json()) as { impersonationFiling?: unknown; pending?: unknown } | null;
    if (body?.pending === true) return on;
    return typeof body?.impersonationFiling === "boolean" ? body.impersonationFiling : null;
  } catch {
    return null;
  }
}
