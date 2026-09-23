/**
 * `GET /local/search-index` — how far this install's search index has got, for the Mailboxes
 * pane's progress arm. The store's own counts (`searchIndexProgress`, the same numbers `/search`
 * answers as `indexed`), read at most every {@link SEARCH_INDEX_READ_EVERY_MS} and not at all once
 * the account's marker is written. Local door only; the launch bearer authorises it.
 */
import { searchIndexBuilt, searchIndexProgress } from "@trafficflow/core/mail";
import type { Tx } from "@trafficflow/db";

export const SEARCH_INDEX_ROUTE = "/local/search-index";
const SEARCH_INDEX_READ_EVERY_MS = 10_000;

interface SearchIndexAnswer {
  built: boolean;
  done: number;
  total: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The door, with its own ten-second memo; a built index is remembered for the process. */
export function createSearchIndexDoor(deps: {
  authorized: (req: Request) => Promise<boolean>;
  db: Tx;
  accountId: string;
  now?: () => number;
}): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  let last: { at: number; answer: SearchIndexAnswer } | null = null;
  return async (req) => {
    if (!(await deps.authorized(req))) {
      return json(401, { error: { code: "unauthorized", message: "authentication required" } });
    }
    if (last !== null && (last.answer.built || now() - last.at < SEARCH_INDEX_READ_EVERY_MS)) {
      return json(200, last.answer);
    }
    const answer: SearchIndexAnswer = (await searchIndexBuilt(deps.db, deps.accountId))
      ? { built: true, done: 0, total: 0 }
      : { built: false, ...(await searchIndexProgress(deps.db, deps.accountId)) };
    last = { at: now(), answer };
    return json(200, answer);
  };
}
