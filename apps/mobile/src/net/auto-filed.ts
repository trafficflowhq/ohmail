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
      return messageId === null || to === null ? [] : [{ messageId, to, from: str(r.from), subject: str(r.subject) }];
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
