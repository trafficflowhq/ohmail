import type { CreateMailboxBody, UpdateMailboxBody } from "@trafficflow/services/mail";
import {
  ProfileUnavailableError, readOrganizerProfile, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { openMailboxImap } from "../attachments-adapter.js";
import { serviceContext } from "../context.js";
import { makeImapProbe, makeSmtpProbe } from "../imap-probe.js";
import { makeOrganizerPeek } from "../organizer-peek.js";
import { jsonResponse } from "../responses.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";
import { mailbox, profileImport, readBody, noContent } from "./shared.js";

/**
 * THE WIRE SHAPE OF `POST /mailboxes/:id/organize`, VALIDATED HERE AND NOWHERE ELSE.
 *
 * `{ imap?: { pass }, screening?: { dormancyDays?, scope? } }`. Every field is optional, and the
 * empty body is the ordinary Cloud claim-back: nothing about the login has changed and the
 * account has been screening for months.
 *
 * ── WHY THE PARSE IS EXPLICIT AND NOT A SPREAD ──────────────────────────────────────────────
 *
 * The body reaches `MailboxService.organizeHere`, which writes `account_settings` and a mailbox
 * CREDENTIAL. Spreading an attacker-supplied object into either would let a caller name columns
 * the route never meant to expose. So each field is read by name and given a type; anything else
 * in the body is dropped silently, which is this codebase's standing answer for a wire object
 * (an unknown key is a client that is ahead of us, not an error to raise).
 *
 * The RANGES are deliberately NOT checked here. `organizeHere` validates `dormancyDays` (1-365)
 * and `scope` inside its own transaction and throws the 400, because that is where the write is
 * and a check in a route is a check one caller can be added past. This function's whole job is
 * to say what SHAPE reached the service.
 */
function organizeInputOf(body: Record<string, unknown>): {
  imap?: { pass: string };
  screening?: { dormancyDays?: number; scope?: "window" | "all_time" };
} {
  const out: { imap?: { pass: string }; screening?: { dormancyDays?: number; scope?: "window" | "all_time" } } = {};
  const imap = body.imap;
  if (imap && typeof imap === "object" && typeof (imap as { pass?: unknown }).pass === "string") {
    const pass = (imap as { pass: string }).pass;
    // An EMPTY password is not a password: it would probe as an auth failure and tell the person
    // their password is wrong when what happened is that the field was blank. Treated as absent,
    // so the ceremony takes the no-credential path and the stored login stands.
    if (pass !== "") out.imap = { pass };
  }
  const screening = body.screening;
  if (screening && typeof screening === "object") {
    const sc: { dormancyDays?: number; scope?: "window" | "all_time" } = {};
    const days = (screening as { dormancyDays?: unknown }).dormancyDays;
    if (typeof days === "number") sc.dormancyDays = days;
    const scope = (screening as { scope?: unknown }).scope;
    if (scope === "window" || scope === "all_time") sc.scope = scope;
    // Present-but-empty is still a consent that must write the BASELINE, which is the whole point
    // of this half riding the same transaction — so the key is set whenever the caller sent the
    // object, even with nothing in it.
    out.screening = sc;
  }
  return out;
}

/**
 * THE WIRE SHAPE OF `POST /mailboxes/probe`, VALIDATED HERE AND NOWHERE ELSE.
 *
 * `{ address, imap: { host, port?, secure?, user?, pass } }`. Read field by field and never
 * spread, on {@link organizeInputOf}'s argument verbatim: the object reaches a function that
 * opens a socket to a host named in it, and spreading an attacker-supplied object into that would
 * let a caller name fields this route never meant to expose.
 *
 * What is NOT checked here: whether the host is dialable, whether the port is a mail port, and
 * whether the address is well-formed. The first two belong to the probe's own SSRF/port guard,
 * which is the only place that knows this deployment's policy, and the third to the service, which
 * canonicalises the address inside its own call. A check here would be a check one caller can be
 * added past — the rule this file already states for `organizeHere`'s ranges.
 */
function probeInputOf(body: Record<string, unknown>): {
  address: string;
  imap: { host: string; port?: number; secure?: boolean; user?: string; pass: string };
} {
  const address = typeof body.address === "string" ? body.address : "";
  const imap = (body.imap && typeof body.imap === "object" ? body.imap : {}) as Record<string, unknown>;
  const out: { address: string; imap: { host: string; port?: number; secure?: boolean; user?: string; pass: string } } = {
    address,
    imap: {
      host: typeof imap.host === "string" ? imap.host : "",
      pass: typeof imap.pass === "string" ? imap.pass : "",
    },
  };
  // PORT AND MODE ARE OPTIONAL AND STAY ABSENT WHEN NOT SENT. Absent is what selects the standard
  // ladder (993 implicit TLS, then 143 STARTTLS); coercing a missing port to a number would pin
  // the probe to one rung and turn "find my server" into "try exactly this and fail".
  if (typeof imap.port === "number") out.imap.port = imap.port;
  if (typeof imap.secure === "boolean") out.imap.secure = imap.secure;
  if (typeof imap.user === "string") out.imap.user = imap.user;
  return out;
}

/**
 * ONE FRESH READ of the mailbox's saved-settings document, for the confirm-import routes below.
 *
 * Built HERE, per request, from the same `openMailboxImap` every other API dial goes through —
 * so it queues behind the same per-mailbox connection cap and inherits the tightened client
 * timeouts (`attachments-adapter.ts` is emphatic about why a second `new ImapAdapter` anywhere
 * else would quietly break the cap's arithmetic). The service receives a thunk rather than an
 * adapter for the probe's reason restated: `packages/services` states what a read must answer
 * and never learns how to open a socket, so its tests inject documents through this argument.
 *
 * Read-only by construction: `readOrganizerProfile` lists the meta folder and writes nothing,
 * exactly as the organizer peek reads the lease without ever renewing one.
 */
const profileReader = (deps: ApiDeps, mailboxId: string) => async (): Promise<ProfileReadResult> => {
  let opened: Awaited<ReturnType<typeof openMailboxImap>>;
  try {
    opened = await openMailboxImap(deps, mailboxId);
  } catch (err) {
    // A `ServiceError` already carries its own honest answer (the connection cap's 429, the
    // missing-credential 502) and passes through. Everything else — a decrypt fault, a refused
    // LOGIN, a dead host — is "could not look", and it must reach the caller as the same 502
    // the read path's own failures do, never as a raw 500 whose text says nothing anyone can
    // act on. `ServiceError` is matched by NAME rather than by class for the middleware's
    // reason: two copies of the services package must not make the same error unrecognisable.
    if (err instanceof Error && err.name === "ServiceError") throw err;
    throw new ProfileUnavailableError(
      "the mailbox could not be dialled to read its saved settings",
      { op: "list_profiles", cause: err },
    );
  }
  try {
    return await readOrganizerProfile(opened.adapter.profileIo());
  } finally {
    // ALWAYS — the peek's rule: a reader that leaked its slot would shrink the mailbox's
    // connection budget until the admission window rolled.
    await opened.close().catch(() => { /* the socket is already gone; the slot is released */ });
  }
};

/**
 * §5.1 — mailboxes READ + RESYNC + the lifecycle mutations. POST/PATCH/
 * DELETE are step-up-gated (recent 2FA) — they carry envelope-encrypted credentials
 * that are encrypted on write and NEVER echoed. DTOs never carry credentials.
 * All queries are account-scoped in the service (404 cross-account).
 */
export const mailboxRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/mailboxes",
    cost: "read",
    handler: async (req, deps) => {
      /**
       * ── `?counts=1` — THE ONE OPT-IN ON THIS ROUTE, AND WHY IT IS OPT-IN ────────────────
       *
       * `MailboxDTO.messageCount` is an aggregate over the account's whole `messages` table.
       * This route is POLLED: `MailStateProvider` reads it every 30 s in every open Cloud tab
       * for the shell's status strip, and Settings → Mailboxes reads it every 10 s while it is
       * open. Neither reads the count. Computing it unconditionally would put a full scan of
       * somebody's mail history behind a heartbeat, twice a minute, per tab.
       *
       * STRICTLY `"1"`, AND ANYTHING ELSE IS THE CHEAP PATH. `params.has("counts")` — or any
       * truthiness read — turns the aggregate ON for `?counts=0` and `?counts=false`, which are
       * the two spellings a caller reaches for to turn it OFF. Since an absent field is a
       * legitimate answer here, an unrecognised value costs a screen its number; the inverse
       * mistake costs the polled route an aggregate nobody asked for.
       *
       * NOT A 400 either. The list is returned either way and this decides one optional field
       * of it, so a malformed value must not break the pane that renders the rest.
       */
      const counts = new URL(req.url).searchParams.get("counts") === "1";
      const items = await mailbox(deps).list(serviceContext(deps, req), { counts });
      return jsonResponse({ items });
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes/:id",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await mailbox(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/:id/resync",
    // `work`. It carried NO options at all until the cost classes existed, which made it the
    // cheapest way to make the worker re-walk an entire mailbox: one POST, and every folder is
    // re-listed against the real IMAP server. Nothing about the verb or the path said so.
    cost: "work",
    handler: async (req, deps, params) => {
      await mailbox(deps).requestResync(serviceContext(deps, req), params.id!);
      return jsonResponse({ status: "queued" }, { status: 202 });
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/:id/inbound-quiet/dismiss",
    // `work` — one timestamp on the caller's own mailbox row (mail 0078): no socket, no spend,
    // no step-up (dismissing a notice about your own mailbox is not a credential act, and a
    // second factor here would teach people the notice is dangerous — it is the opposite).
    // Naturally idempotent: a repeat press re-stamps the same dismissal.
    cost: "work",
    handler: async (req, deps, params) => {
      const dto = await mailbox(deps).dismissInboundQuiet(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes/:id/organizer",
    // `connection`, NOT `read`. `read` is defined as reading rows already stored for the caller's
    // own account and writing nothing; this opens an IMAP socket to the user's provider and reads
    // a folder on it. Classing it `read` would also put it inside the set an UNVERIFIED account
    // may reach, which would make an unproven address able to make this process dial a mail server
    // — and an unverified account must not be able to make this service do paid work.
    cost: "connection",
    handler: async (req, deps, params) => {
      const ctx = serviceContext(deps, req);
      // OWNERSHIP FIRST, AND BEFORE THE DIAL. Without it a guessed mailbox id is a connect oracle
      // against somebody else's stored credentials — the same reason `probedImapMeta` does its
      // unlocked pre-read before it probes.
      await mailbox(deps).get(ctx, params.id!);
      const organizer = await makeOrganizerPeek(deps)(params.id!);
      return jsonResponse(organizer);
    },
  },
  {
    method: "POST",
    // RENAMED from `/takeover` (mail 0083). "Takeover" was true of the only case that existed —
    // wresting a mailbox back from another install — and is false of the case that is now the
    // common one: the FIRST consent, where there is nobody to take it over from. The client's
    // one caller (`MailboxSection.tsx`) is updated in the same commit; there is no compatibility
    // window to keep because the old name has never been public API.
    pattern: "/mailboxes/:id/organize",
    // `connection`, NOT `work` — CHANGED with the rename, and it is a real change rather than
    // tidiness. The ceremony may now carry a password, and a password is PROVED against the
    // customer's provider before anything is written (`QAR-TAKEOVER-NEEDS-A-READABLE-CREDENTIAL`:
    // a stamp on a mailbox whose stored login no longer works is an action that looks like it
    // worked and leaves the mailbox quarantined). That dial is what `connection` classes, and it
    // is also what keeps this route outside the set an UNVERIFIED account may reach — an unproven
    // address must not be able to make this service dial a mail server.
    cost: "connection",
    // Step-up for the reason `POST /mailboxes` carries it — this decides who moves somebody's
    // mail — and now for a second: the body may contain a mailbox password.
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      // NO IMAP ORGANIZING. The optional probe is a LOGIN, one round trip, and it writes nothing
      // to the mailbox — asserted by the same test that has always asserted this route appends
      // nothing. Organization lands in real folders and the WORKER is what puts it there, so this
      // writes a stamp and returns. A confirm that organized would be a second organizer deciding
      // things in a serverless function.
      const input = organizeInputOf(await readBody<Record<string, unknown>>(req));
      const result = await mailbox(deps).organizeHere(
        serviceContext(deps, req), params.id!, input,
        // The probe is injected only when there is a password to prove, on the same seam
        // `PATCH /mailboxes/:id` uses — one prober, per request, inheriting the deadline and the
        // IMAP admission counter.
        { probe: makeImapProbe(deps) },
      );
      return jsonResponse(result, { status: result.outcome === "authorized" ? 202 : 200 });
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes/:id/profile-import",
    // `connection`, on the organizer peek's argument verbatim: the interesting branch opens an
    // IMAP socket to the user's provider, and `read` would put a mail-server dial inside the
    // set an unproven address may reach. The COMMON branch never dials — the service answers
    // "none" from the durable found-marker alone — which is what makes this route cheap enough
    // for the shell to ask once per mailbox per tab.
    cost: "connection",
    handler: async (req, deps, params) => {
      // Ownership is the service's first act, before any marker read and long before the dial —
      // the peek's connect-oracle rule, kept in the service so every host that mounts these
      // routes inherits it rather than re-stating it.
      const dto = await profileImport(deps).candidate(
        serviceContext(deps, req), params.id!, { read: profileReader(deps, params.id!) },
      );
      return jsonResponse(dto);
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/:id/profile-import",
    // `connection` — it re-reads the document from the mailbox before applying, so the dial is
    // part of what this handler causes (alongside the store writes `work` alone would name).
    // NOT step-up gated, deliberately: it writes the same rows the rules/tags/contacts surfaces
    // write without one, touches no credential, and the confirmation it demands instead is the
    // fingerprint — the exact content the user was shown, re-verified against the mailbox.
    cost: "connection",
    handler: async (req, deps, params) => {
      const body = await readBody<{ fingerprint?: string }>(req);
      const result = await profileImport(deps).apply(
        serviceContext(deps, req), params.id!, body, { read: profileReader(deps, params.id!) },
      );
      return jsonResponse(result);
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/:id/profile-import/decline",
    // `work`: one marker row, no dial — declining must stay possible when the mailbox itself
    // is unreachable, because "keep what I have" is exactly the answer someone gives a prompt
    // they cannot re-verify.
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<{ fingerprint?: string; v?: number }>(req);
      await profileImport(deps).decline(serviceContext(deps, req), params.id!, body);
      return jsonResponse({ dismissed: true });
    },
  },
  {
    method: "POST",
    /**
     * TEST A CONNECTION WITHOUT MAKING ONE — the action every mailbox form has been missing.
     *
     * Until this route the only way to discover whether a set of mail-server details worked was to
     * submit them and watch the mailbox either appear or not. All fourteen failure sentences were
     * reachable only as the by-product of a create that did not happen, and there was no success
     * sentence anywhere in the product because nothing could produce one.
     *
     * ── NO `:id`, BECAUSE THE POINT IS THAT THERE IS NO MAILBOX YET ─────────────────────────
     *
     * It is a PRE-create action, so there is no row to own and no ownership check to make. What
     * bounds it is entirely the probe closure built below: the SSRF/port guard that refuses a
     * private address on the hosted deployment, the per-address admission counter, and the
     * deadline. A handler that dialled by hand would compile, classify correctly, and have none of
     * them — which is why the probe is constructed here and never inside the service.
     *
     * ── `connection`, AND THAT IS WHAT KEEPS IT AWAY FROM AN UNVERIFIED ACCOUNT ──────────────
     *
     * The whole handler is one dial to a host the caller typed. `read` would put a mail-server
     * dial inside the set an unproven address may reach, which is the connect oracle the peek
     * route's comment argues at length; `work` would be a claim that it writes something, and it
     * writes nothing at all. Step-up for `POST /mailboxes`'s reason with nothing subtracted: the
     * body carries a mailbox password.
     */
    pattern: "/mailboxes/probe",
    cost: "connection",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<Record<string, unknown>>(req);
      const dto = await mailbox(deps).probeConnection(
        serviceContext(deps, req), probeInputOf(body),
        // THE ONE CALL SITE THAT ASKS FOR A FOLDER COUNT. Every other probe in this file is built
        // without it, so no create and no claim pays a LIST for a number it does not read.
        { probe: makeImapProbe(deps, { countFolders: true }) },
      );
      return jsonResponse(dto);
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes",
    // `work`, and it is the most expensive member of that class rather than an exception
    // to it. The API stores an encrypted credential and returns; what the credential BUYS is a
    // persistent IMAP connection and a full sync of somebody's mailbox, which is why this was
    // one of only two routes the verification gate was ever set on by hand. The gate now comes
    // from the class, ALONGSIDE `stepUp`, because the two answer different questions: the
    // step-up proves somebody is present at the keyboard right now, and the verification proves
    // the address on the account is real and belongs to whoever is typing — the backstop at the
    // other end of the account pre-hijack chain `AuthService.verifyEmail`'s password binding
    // closes.
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<CreateMailboxBody>(req);
      // The credentials are tried before they are stored, and the probe is built HERE,
      // per request, from `deps`. Same seam and same reason as `routes/attachments.ts` building
      // `makeOpenAdapter(deps)` at its own call site: `packages/services` states what a probe
      // must answer and never learns how to open a socket, so every service test injects a fake
      // through this argument. `MailboxService.create` requires it — a create that could omit it
      // is a create that can store an untried password.
      const dto = await mailbox(deps).create(serviceContext(deps, req), body, {
        probe: makeImapProbe(deps),
        // The SMTP block is tried too — a submission host whose certificate cannot be verified
        // must refuse HERE, on the form, not at the user's first send. Same seam shape.
        smtpProbe: makeSmtpProbe(deps),
      });
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "PATCH",
    pattern: "/mailboxes/:id",
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      const body = await readBody<UpdateMailboxBody>(req);
      // The SAME probe, injected the same way, at the other door into `mailbox_credentials`. A
      // rotated password reaching this route used to be encrypted and stored with zero
      // connection attempts, which is `POST /mailboxes`'s original defect one screen later —
      // and this is the route the desktop sends a user to when its stored login can no longer
      // be read (`apps/sidecar/src/engine.ts`). Built from `deps` per request, so it inherits
      // the deadline, the tightened client timeouts and the IMAP admission counter rather than
      // re-deriving any of them.
      const dto = await mailbox(deps).update(serviceContext(deps, req), params.id!, body, {
        probe: makeImapProbe(deps),
        smtpProbe: makeSmtpProbe(deps),
      });
      return jsonResponse(dto);
    },
  },
  {
    method: "DELETE",
    pattern: "/mailboxes/:id",
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      const { seq } = await mailbox(deps).delete(serviceContext(deps, req), params.id!);
      // ── THE DELTA CONTRACT'S ECHO, ON A 204 ────────────────────────────────────────────
      //
      // A removal closes the mailbox's pending scheduled sends, which is a `draft` change the
      // mirror that asked for the removal has to apply. Without the echo it has no seq to wait
      // for and keeps rendering the appointment until the next drain — `DELETE /drafts/:id`
      // sets the precedent for a 204 that carries one. Absent when nothing was closed, which is
      // the ordinary case: there is no change, so there is no seq, and inventing one would name
      // a row that does not exist.
      //
      // ── TWO RESIDUALS, WRITTEN DOWN RATHER THAN QUIETLY LEFT — both serious ──
      //
      // 1. NOTHING ON THE MAILBOX PATH CONSUMES THIS HEADER TODAY, and that is a property of
      //    which client makes the call rather than of this line. The engine's mutation path DOES
      //    read it and converge on it (`client-engine/src/adapters/http-adapter.ts:439` tracks
      //    the highest seq seen and waits for `/sync` to reach it) — but the engine never issues
      //    a mailbox mutation. `POST /mailboxes`, `PATCH /mailboxes/:id` and this route are all
      //    the settings pane's own REST calls through `apps/webapp/app/api-client.ts`, whose
      //    `api<void>` returns at 204 before it looks at a header, and the pane holds no engine
      //    handle to converge with (`useMailState` is mailbox facts and a refresh, nothing more).
      //    So a closed appointment reaches the Drafts list on the NOTIFY-driven `/sync` drain
      //    instead of read-your-writes.
      //    The header is still the RIGHT answer and is kept: it is what the contract requires of
      //    the server, and a conforming client gets it for free the moment the mailbox family
      //    goes through the engine. Closing the gap means giving a settings pane an engine
      //    handle — a seam that exists for no mailbox mutation — and inventing it for one verb
      //    would be the half-wired surface this app removes elsewhere. Filed, not hidden.
      //
      // 2. THIS ROUTE IS UNKEYED, so a lost 204 cannot be replayed: the retry finds the
      //    tombstone, closes zero rows, and answers 204 with no seq. `DELETE /rules/:id` shows
      //    exactly what keying it would look like (a bespoke lookup/hash/replay, because
      //    `withIdempotency` cannot replay a bodiless 204). It is deliberately NOT done here.
      //
      //    The rule: exactly three mailbox routes spend without an idempotency key — this one,
      //    `POST /mailboxes` and `PATCH /mailboxes/:id` — and they are enumerated as one set
      //    rather than each being argued about on its own, so the remaining work has a definite
      //    scope instead of a feeling. Keying one of the three inside a removal slice would spend
      //    that scope arbitrarily and leave the other two looking decided. All three move
      //    together or none does.
      return seq === null
        ? noContent()
        : new Response(null, { status: 204, headers: { "X-Sync-Seq": String(seq) } });
    },
  },
];
