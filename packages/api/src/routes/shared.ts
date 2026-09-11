import {
  ServiceError, generateToken, profileImportService, syncService,
  type SyncService, type PushService, type MailboxService, type RulesService,
  type MessageService, type ThreadService,
  type ScreenerService, type ApprovalService, type TriageService, type SearchService,
  type PrivacyService, type UnsubscribeService,
  type ContactsService, type SnippetsService, type NotifyRulesService, type AwayResponderService,
  type AttachmentsService, type KbService, type TagsService, type FolderOpsService, type DraftsService, type DraftingService,
  type ScheduleService,
  type ProfileImportService, type SendService, type WorkflowsService,
} from "@trafficflow/services/mail";
import type { DraftPort } from "@trafficflow/core/mail";
import {
  accessOf, isMetered,
  type AccessVerdict, type EntitlementsComposition, type EntitlementsPort, type SpendPort,
} from "@trafficflow/db";
import type { ImapAdmissionPort, ApiDeps } from "../deps.js";

/* THE MAIL-HALF ACCESSORS ONLY. The hosted ones — the identity ceremony, the two paid surfaces,
 * the funnel, the proposer, and the helpers that mint a browser session for a completed ceremony —
 * are in `shared-cloud.ts`.
 *
 * The note that stood here said a type-only import was erased at emit and therefore safe to make
 * from the full service barrel. That is true about the ARTIFACT and false about everything else: a
 * type import is plainly readable in the source, and a checkout that does not contain the module
 * cannot compile the file that names it. Erasure answers the bundling question only. */

/**
 * WHAT THIS HOST DECLARED ABOUT ENTITLEMENTS — three states, told apart here and nowhere else.
 *
 *  · a port      — a program answers; `access` may refuse and a manage link may exist;
 *  · `UNMETERED` — this deployment operates no such program. Every limit is off, by decision;
 *  · absent      — nobody finished the composition. Gates nothing, offers no link, and is a
 *    configuration error rather than a free tier: it is NOT the same fact as `UNMETERED`, which
 *    is exactly why the member is filled out loud by every host that means it.
 */
export function entitlementsOf(deps: ApiDeps): EntitlementsComposition | null {
  return deps.services?.entitlementsPort ?? null;
}

/** The port, or `null` on an unmetered or unfinished host — the two that answer no manage link. */
export function entitlementsPort(deps: ApiDeps): EntitlementsPort | null {
  const e = entitlementsOf(deps);
  return e !== null && isMetered(e) ? e : null;
}

/**
 * WHO CHARGES AN AI ACTION HERE, or nobody — the spend half alone, for the routes that spend.
 *
 * `undefined` for both an UNMETERED host and an unfinished one, and that collapse is correct for
 * THIS question and only this one: a call site's answer to "nobody meters here" is the same in
 * both cases — run the model, charge nothing — while `access` must keep them apart, because
 * refusing on an unfinished composition would lock every account out of an install whose operator
 * simply has no entitlements program. The routes that spend never need to tell the two apart; the
 * one that renders a manage link does, and it uses `entitlementsPort` above.
 */
export function spendOf(deps: ApiDeps): SpendPort | undefined {
  const e = entitlementsOf(deps);
  return e !== null && isMetered(e) ? e : undefined;
}

/**
 * This account's access verdict, or `null` when there is no declaration to read one from.
 *
 * `null` and a refusal are different answers and the caller must not collapse them: `null` means
 * the question was never armed on this host, and refusing on it would lock every account out of
 * an install whose operator simply has no entitlements program.
 */
export async function accessFor(deps: ApiDeps, accountId: string): Promise<AccessVerdict | null> {
  const e = entitlementsOf(deps);
  return e === null ? null : accessOf(e, accountId);
}

/** The SyncService — falls back to the stateless singleton when the bag omits it. */
export function sync(deps: ApiDeps): SyncService {
  return deps.services?.sync ?? syncService;
}

export function push(deps: ApiDeps): PushService {
  const svc = deps.services?.push;
  if (!svc) throw new ServiceError("internal", 500, "push service not configured");
  return svc;
}

/**
 * The host's IMAP admission port. NO fallback, on purpose: an absent port must not read as
 * "admit". See {@link ImapAdmissionPort} for why the counter is injected rather than imported.
 */
export function imapAdmission(deps: ApiDeps): ImapAdmissionPort {
  const port = deps.services?.imapAdmission;
  if (!port) throw new ServiceError("internal", 500, "IMAP admission is not configured");
  return port;
}

export function mailbox(deps: ApiDeps): MailboxService {
  const svc = deps.services?.mailbox;
  if (!svc) throw new ServiceError("internal", 500, "mailbox service not configured");
  return svc;
}

export function rules(deps: ApiDeps): RulesService {
  const svc = deps.services?.rules;
  if (!svc) throw new ServiceError("internal", 500, "rules service not configured");
  return svc;
}

export function message(deps: ApiDeps): MessageService {
  const svc = deps.services?.message;
  if (!svc) throw new ServiceError("internal", 500, "message service not configured");
  return svc;
}

export function thread(deps: ApiDeps): ThreadService {
  const svc = deps.services?.thread;
  if (!svc) throw new ServiceError("internal", 500, "thread service not configured");
  return svc;
}

export function screener(deps: ApiDeps): ScreenerService {
  const svc = deps.services?.screener;
  if (!svc) throw new ServiceError("internal", 500, "screener service not configured");
  return svc;
}

export function approval(deps: ApiDeps): ApprovalService {
  const svc = deps.services?.approval;
  if (!svc) throw new ServiceError("internal", 500, "approval service not configured");
  return svc;
}

export function triage(deps: ApiDeps): TriageService {
  const svc = deps.services?.triage;
  if (!svc) throw new ServiceError("internal", 500, "triage service not configured");
  return svc;
}

export function search(deps: ApiDeps): SearchService {
  const svc = deps.services?.search;
  if (!svc) throw new ServiceError("internal", 500, "search service not configured");
  return svc;
}

export function privacy(deps: ApiDeps): PrivacyService {
  const svc = deps.services?.privacy;
  if (!svc) throw new ServiceError("internal", 500, "privacy service not configured");
  return svc;
}

/**
 * The UnsubscribeService — **503, not 500, when the deployment has none.**
 *
 * Same posture as {@link billing} and {@link waitlistSvc}, and for a sharper reason than either:
 * this service needs a trust decision — which authserv-ids each mailbox's own provider signs
 * `Authentication-Results` with (`UnsubscribeDeps.trustedAuthservIdsFor`, resolved per mailbox
 * from its credential row's IMAP host). A host that has not wired that resolver is
 * not broken, it is a host that does not offer unsubscribe, and saying so is better than acting
 * on an unauthenticated sender's URL.
 */
export function unsubscribes(deps: ApiDeps): UnsubscribeService {
  const svc = deps.services?.unsubscribe;
  if (!svc) {
    throw new ServiceError(
      "unsubscribe_unconfigured", 503,
      "one-click unsubscribe is not available on this deployment", undefined, false,
    );
  }
  return svc;
}

export function contacts(deps: ApiDeps): ContactsService {
  const svc = deps.services?.contacts;
  if (!svc) throw new ServiceError("internal", 500, "contacts service not configured");
  return svc;
}

export function snippets(deps: ApiDeps): SnippetsService {
  const svc = deps.services?.snippets;
  if (!svc) throw new ServiceError("internal", 500, "snippets service not configured");
  return svc;
}

export function notify(deps: ApiDeps): NotifyRulesService {
  const svc = deps.services?.notify;
  if (!svc) throw new ServiceError("internal", 500, "notify service not configured");
  return svc;
}

export function away(deps: ApiDeps): AwayResponderService {
  const svc = deps.services?.away;
  if (!svc) throw new ServiceError("internal", 500, "away service not configured");
  return svc;
}

/**
 * The profile-import service — the confirm/decline side of the portable organizer profile.
 * Falls back to the stateless singleton like `sync` does: it holds no construction-time
 * dependency (the IMAP read arrives per call, from the route), so every host gets the same
 * instance and a test overrides it through the bag when it needs a spy.
 */
export function profileImport(deps: ApiDeps): ProfileImportService {
  return deps.services?.profileImport ?? profileImportService;
}

export function attachments(deps: ApiDeps): AttachmentsService {
  const svc = deps.services?.attachments;
  if (!svc) throw new ServiceError("internal", 500, "attachments service not configured");
  return svc;
}

export function kb(deps: ApiDeps): KbService {
  const svc = deps.services?.kb;
  if (!svc) throw new ServiceError("internal", 500, "kb service not configured");
  return svc;
}

export function tags(deps: ApiDeps): TagsService {
  const svc = deps.services?.tags;
  if (!svc) throw new ServiceError("internal", 500, "tags service not configured");
  return svc;
}

export function folderOps(deps: ApiDeps): FolderOpsService {
  const svc = deps.services?.folderOps;
  if (!svc) throw new ServiceError("internal", 500, "folder ops service not configured");
  return svc;
}

export function drafts(deps: ApiDeps): DraftsService {
  const svc = deps.services?.drafts;
  if (!svc) throw new ServiceError("internal", 500, "drafts service not configured");
  return svc;
}

export function schedules(deps: ApiDeps): ScheduleService {
  const svc = deps.services?.schedules;
  if (!svc) throw new ServiceError("internal", 500, "schedule service not configured");
  return svc;
}

export function drafting(deps: ApiDeps): DraftingService {
  const svc = deps.services?.drafting;
  if (!svc) throw new ServiceError("internal", 500, "drafting service not configured");
  return svc;
}

export function sends(deps: ApiDeps): SendService {
  const svc = deps.services?.sends;
  if (!svc) throw new ServiceError("internal", 500, "send service not configured");
  return svc;
}

export function workflows(deps: ApiDeps): WorkflowsService {
  const svc = deps.services?.workflows;
  if (!svc) throw new ServiceError("internal", 500, "workflows service not configured");
  return svc;
}

/**
 * The injected DraftPort (deployment-configured Anthropic client, or a test mock). Absent is a
 * deployment fact, not a fault: a preview, a local run and a rules-only host all legitimately
 * have no `ANTHROPIC_API_KEY`, so this is 503 `drafter_unconfigured` — not the `500 internal` it
 * used to be, which logged a healthy host as failing and told the client nothing it could render.
 * `retryable: false` because only an operator can clear it. The code is shared with
 * `WorkflowsService.enqueueRun`'s enqueue-time refusal on purpose: both mean exactly "this
 * deployment has no drafter", and a client that learns to render it must not learn it twice.
 */
export function drafter(deps: ApiDeps): DraftPort {
  const port = deps.services?.drafter;
  if (!port) {
    throw new ServiceError(
      "drafter_unconfigured", 503,
      "this deployment has no AI drafter connected", undefined, false,
    );
  }
  return port;
}

/** Parse a request JSON body; `{}` for an empty body, 400 for malformed JSON. */
export async function readBody<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ServiceError("validation_failed", 400, "invalid JSON body");
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/** JSON body + optional Set-Cookie headers (multiple, via append). */
export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/** 204 No Content, optionally carrying Set-Cookie headers. */
export function noContent(cookies: string[] = []): Response {
  const headers = new Headers();
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 204, headers });
}

/**
 * Is this host a cookie surface? One decision, consulted everywhere. `ApiDeps.allowCookieAuth`
 * used to gate one thing — `readSessionToken`'s reading of `tf_session` — which made
 * "bearer-only" true of the session cookie and nothing else: `POST /auth/refresh` still read
 * `tf_refresh` off the header on any host, and every public auth completion still answered with
 * `Set-Cookie`. The flag now gates cookie ingress and egress alike: on a host that does not
 * accept cookies, no `tf_*` value is read and none is written. A native client is unaffected — it
 * gets the tokens in the body, the only place it could use them.
 */
export function cookieSurface(deps: ApiDeps): boolean {
  return deps.allowCookieAuth !== false;
}

/** The device kind to label a session exchanged on THIS request's transport. */
export function clientKind(deps: ApiDeps): "web" | "macos" {
  return deps.session?.via === "bearer" ? "macos" : "web";
}
