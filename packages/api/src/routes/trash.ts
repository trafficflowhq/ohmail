import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import { listServerTrash, searchServerTrash, serverTrashBody } from "../trash-window.js";
import type { Route } from "../router.js";

/**
 * THE TRASH WINDOW'S THREE DOORS — a live, un-mirrored read of the provider's own \Trash.
 *
 * The Trash VIEW's own list is `GET /messages?view=trash`, which reads the mirror: the messages
 * ohmail deleted, with their origin folder and their restore. These three answer the other
 * population — mail deleted in another mail client, which the sync never sees because
 * `imap-types.ts`'s reading rule gives that folder no cursor.
 *
 * All three are `GET` and all three are `cost: "connection"` (they dial). NONE of them writes:
 * `trash-window.ts` carries the argument and `trash-window.test.ts` counts the mirror tables
 * before and after every read. There is deliberately no verb here — see that module's header for
 * why "put it back" has no destination for a message the mirror has never held.
 *
 * `/trash/window` contends with nothing: there is no `/trash/:id`.
 */
export const trashRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/trash/window",
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
      return jsonResponse(await listServerTrash(deps, ctx.accountId, { cursor }));
    },
  },
  {
    // Body-on-open: live fetch, parsed to TEXT (Trash holds whatever was deleted, spam included,
    // so it renders on the Junk window's terms — no remote content, no markup, no tracker),
    // bounded by `TRASH_BODY_MAX_BYTES`, never persisted.
    method: "GET",
    pattern: "/trash/window/body",
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const url = new URL(req.url);
      const mailboxId = url.searchParams.get("mailboxId") ?? "";
      const uid = Number(url.searchParams.get("uid"));
      // The row's epoch, REQUIRED: a UID names a message only within one UIDVALIDITY, and an
      // emptied-and-recreated folder must answer 410 — never the body of whatever now wears the
      // number. The narrow checks on both values live in the service, so every caller gets them.
      const uidValidity = url.searchParams.get("uidValidity") ?? "";
      if (!mailboxId || !Number.isInteger(uid) || uid <= 0 || !uidValidity) {
        throw new ServiceError(
          "validation_failed", 400,
          "mailboxId, a positive integer uid and uidValidity are required",
        );
      }
      return jsonResponse(await serverTrashBody(deps, ctx.accountId, { mailboxId, uid, uidValidity }));
    },
  },
  {
    // One server-side SEARCH per Trash folder, behind the same read budget as the list, the
    // newest hits merged. The client asks only after its own filter over the loaded window came
    // up empty, so the first paint never waits on this.
    method: "GET",
    pattern: "/trash/window/search",
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const q = new URL(req.url).searchParams.get("q") ?? "";
      return jsonResponse(await searchServerTrash(deps, ctx.accountId, q));
    },
  },
];
