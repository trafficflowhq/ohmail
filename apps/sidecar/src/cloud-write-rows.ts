import { matchSpec } from "@trafficflow/api/match-path";
import type { RelaySpec } from "@trafficflow/api/relay-allowlist";

/**
 * WHAT A FORWARDED WRITE CHANGES THAT THIS INSTALL SERVES FROM ITS OWN COPY — one entry per
 * non-GET relay route. `none`: every read of it is relayed to the hosted server, so nothing here can
 * be stale and the answer goes back at once. `sync`: rows the window drains from this install's
 * `/sync`; `verbs` are the window engine's mutation kinds that send it (their shadow is
 * `SHADOWED_ROWS`), `[]` a direct call the echo-await alone covers. `mailboxes`: the local
 * `GET /mailboxes` rows, covered by a mailbox refresh begun after the answer.
 */
export type WriteRows = "none" | "sync" | "mailboxes" | "sync+mailboxes";

export interface WriteRoute {
  readonly rows: WriteRows;
  readonly verbs?: readonly string[];
}

const none: WriteRoute = { rows: "none" };
const direct: WriteRoute = { rows: "sync", verbs: [] };
const mbx: WriteRoute = { rows: "mailboxes" };
const verbs = (...v: string[]): WriteRoute => ({ rows: "sync", verbs: v });

/** Keyed `METHOD pattern`, exactly as `RELAY_ALLOWLIST` spells it; the census holds the two equal. */
export const WRITE_ROWS: Readonly<Record<string, WriteRoute>> = {
  "DELETE /account": none,
  "DELETE /auth/2fa/totp": none,
  "DELETE /devices/:id": none,
  "DELETE /drafts/:id": verbs("draft_discard"),
  "DELETE /drafts/:id/schedule": verbs("draft_schedule_cancel"),
  "DELETE /folders/:id": verbs("folder_delete"),
  "DELETE /folders/:id/op": verbs("folder_op_dismiss"),
  "DELETE /kb/:id": none,
  "DELETE /mailboxes/:id": { rows: "sync+mailboxes", verbs: [] },
  "DELETE /messages/:id": verbs("message_delete"),
  "DELETE /notes/:id": none,
  "DELETE /notify-rules/:id": none,
  "DELETE /pair/:id": none,
  "DELETE /push/subscriptions/:id": none,
  "DELETE /rules/:id": verbs("rule_delete"),
  "DELETE /snippets/:id": none,
  "DELETE /tags/:id": verbs("tag_delete"),
  "DELETE /workflows/:id": none,
  "PATCH /account/ai": none,
  "PATCH /account/screening": none,
  "PATCH /consent/settings": direct,
  "PATCH /contacts/:id": none,
  "PATCH /folders/:id": verbs("folder_rename"),
  "PATCH /mailboxes/:id": mbx,
  "PATCH /messages": verbs("mark_seen"),
  "PATCH /messages/:id": verbs("feed_mark_seen"),
  "PATCH /notes/:id": none,
  "PATCH /rules/:id": verbs("rule_update"),
  "PATCH /tags/:id": verbs("tag_rename", "tag_recolor"),
  "PATCH /threads/:id": direct,
  "PATCH /workflows/:id": none,
  "POST /account/manage-link": none,
  "POST /approvals/:id": direct,
  "POST /attachments/staging": none,
  "POST /auth/2fa/recovery-codes": none,
  "POST /auth/2fa/totp/activate": none,
  "POST /auth/2fa/totp/enroll": none,
  "POST /auth/2fa/webauthn/assert/options": none,
  "POST /auth/2fa/webauthn/register/options": none,
  "POST /auth/2fa/webauthn/register/verify": none,
  "POST /auth/logout": none,
  "POST /auth/step-up/totp": none,
  "POST /auth/step-up/webauthn/options": none,
  "POST /auth/step-up/webauthn/verify": none,
  "POST /auth/verify-email/resend": none,
  "POST /consent/reset": direct,
  "POST /consent/seed": direct,
  "POST /contacts/:id/notes": none,
  "POST /devices/revoke-web-sessions": none,
  "POST /drafts": verbs("draft_save"),
  "POST /drafts/:id/resolve": verbs("draft_resolve"),
  "POST /drafts/:id/schedule": direct,
  "POST /drafts/:id/send": verbs("mail_send"),
  "POST /files/download-all": none,
  "POST /folders": verbs("folder_create"),
  "POST /kb": none,
  "POST /mailboxes": mbx,
  "POST /mailboxes/:id/inbound-quiet/dismiss": mbx,
  "POST /mailboxes/:id/organize": mbx,
  "POST /mailboxes/:id/organizer-notice/dismiss": mbx,
  "POST /mailboxes/:id/profile-import": { rows: "sync+mailboxes", verbs: [] },
  "POST /mailboxes/:id/profile-import/decline": none,
  "POST /mailboxes/:id/release": mbx,
  "POST /mailboxes/:id/resync": none,
  "POST /mailboxes/oauth/microsoft/complete": mbx,
  "POST /mailboxes/oauth/microsoft/device/poll": mbx,
  "POST /mailboxes/oauth/microsoft/device/start": none,
  "POST /mailboxes/oauth/microsoft/start": none,
  "POST /mailboxes/probe": none,
  "POST /messages/:id/attachments/download-all": none,
  "POST /messages/:id/draft": direct,
  "POST /messages/:id/load-remote": direct,
  "POST /messages/:id/move": verbs("move"),
  "POST /messages/:id/restore": direct,
  "POST /messages/:id/tags": verbs("tag_assign"),
  "POST /messages/:id/triage": verbs("triage_set"),
  "POST /messages/:id/unsubscribe": direct,
  "POST /notify-rules": none,
  "POST /pair": none,
  "POST /push/subscriptions": none,
  "POST /rules": verbs("rule_create"),
  "POST /screener/:id": verbs("screener_decide"),
  "POST /screener/held-releases": direct,
  "POST /screener/held-releases/dismiss": direct,
  "POST /screener/unscreened": direct,
  "POST /screener/junk/rescue": direct,
  "POST /screener/junk/sweep": direct,
  "POST /screener/suggest": direct,
  "POST /snippets": none,
  "POST /sync/pull": none,
  "POST /tags": verbs("tag_create"),
  "POST /threads/:id/notes": none,
  "POST /threads/:id/rename": direct,
  "POST /threads/merge": direct,
  "POST /workflow-runs/:id/undo": direct,
  "POST /workflows": none,
  "POST /workflows/:id/run": direct,
  "POST /workflows/proposals/:id/dismiss": none,
  "PUT /away-responder": none,
  "PUT /drafts/:id": verbs("draft_save"),
  "PUT /kb/:id": none,
  "PUT /snippets/:id": none,
};

const SPECS: readonly RelaySpec[] = Object.keys(WRITE_ROWS).map((k) => {
  const at = k.indexOf(" ");
  return { method: k.slice(0, at), pattern: k.slice(at + 1) };
});

/** The entry for one request, or null for a route the table does not name (read as `sync`). */
export function writeRowsOf(method: string, pathname: string): WriteRoute | null {
  const hit = matchSpec(SPECS, method, pathname);
  return hit.matched ? WRITE_ROWS[`${hit.spec.method} ${hit.spec.pattern}`] ?? null : null;
}

/** The census: relay writes the table does not name, and entries no relay route carries. */
export function writeCensus(
  allowlist: readonly RelaySpec[],
  table: Readonly<Record<string, WriteRoute>> = WRITE_ROWS,
): { missing: string[]; stale: string[] } {
  const writes = allowlist.filter((s) => s.method !== "GET" && s.method !== "HEAD").map((s) => `${s.method} ${s.pattern}`);
  const have = new Set(writes);
  return {
    missing: writes.filter((k) => !(k in table)),
    stale: Object.keys(table).filter((k) => !have.has(k)),
  };
}
