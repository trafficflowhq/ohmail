import type { CreateMailboxBody, UpdateMailboxBody } from "@trafficflow/services/mail";
/* The mirror read (mail 0094). From `/mail`, the LOCAL barrel — this route is mounted by the
   desktop engine too, and naming the root barrel here would pull the hosted schema into a shipped
   app (the rule at the top of `packages/db/src/index.ts`). */
import { readMailboxProfile, RECIPIENT_ADDRESS_MAX_CHARS } from "@trafficflow/services/mail";
import {
  ProfileUnavailableError, readOrganizerProfile, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { isImapDoorTimeout, withinDoorBudget } from "../imap-door.js";
import { serviceContext } from "../context.js";
import { makeImapProbe, makeSmtpProbe } from "../imap-probe.js";
import { makeOrganizerPeek } from "../organizer-peek.js";
import { jsonResponse } from "../responses.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";
import { mailbox, profileImport, readBody, noContent } from "./shared.js";

/**
 * The wire shape of `POST /mailboxes/:id/organize`, validated here and nowhere else. `{ imap?: {
 * pass }, screening?: { dormancyDays?, scope? } }` — every field optional, and the empty body is
 * the ordinary Cloud claim-back. The parse is explicit and never a spread: the body reaches
 * `organizeHere`, which writes `account_settings` and a mailbox credential, and spreading an
 * attacker-supplied object would let a caller name columns the route never meant to expose;
 * unknown keys are dropped silently (a client that is ahead of us, not an error). Ranges are
 * deliberately not checked here: `organizeHere` validates inside its own transaction, where the
 * write is — a check in a route is a check one caller can be added past.
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
 * The wire shape of `POST /mailboxes/probe`, validated here and nowhere else. Read field by field
 * and never spread, on {@link organizeInputOf}'s argument: the object reaches a function that
 * opens a socket to a host named in it. Not checked here: whether the host is dialable or the
 * port a mail port (the probe's own SSRF/port guard — the only place that knows this deployment's
 * policy) and whether the address is well-formed (the service canonicalises it). A check here
 * would be a check one caller can be added past.
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
 * One fresh read of the mailbox's saved-settings document, for the confirm-import routes below.
 * Built here, per request, from the same `openMailboxImap` every other API dial goes through —
 * the same per-mailbox connection cap and tightened client timeouts (`attachments-adapter.ts`
 * says why a second `new ImapAdapter` anywhere would break the cap's arithmetic). The service
 * receives a thunk, not an adapter: `packages/services` states what a read must answer and never
 * learns how to open a socket. Read-only by construction: `readOrganizerProfile` lists the meta
 * folder and writes nothing, as the organizer peek reads the lease without renewing one.
 */
const profileReader = (deps: ApiDeps, mailboxId: string) => async (): Promise<ProfileReadResult> => {
  try {
    /* A NAMED READER RATHER THAN AN ORGANIZER'S IDENTITY. This route only reads: it never
     * appends a settings document, so it records no position and its memory stays empty. The
     * identity is still explicit and still its own, because borrowing an organizer's would let
     * an API read and an organizer's write share one remembered position.
     *
     * UNDER THE DOOR BUDGET, dial and read together, with the socket DESTROYED on a breach. This
     * is the repeatable door on the unbounded read: a signed-in caller could ask for it as often
     * as they liked, and neither the dial nor the walk had a clock. */
    return await withinDoorBudget(
      deps, mailboxId,
      (adapter) => readOrganizerProfile(
        adapter.profileIo({ installId: "api-profile-reader", mailboxId }),
      ),
    );
  } catch (err) {
    // A `ServiceError` already carries its own honest answer (the connection cap's 429, the
    // missing-credential 502) and passes through. Everything else — a decrypt fault, a refused
    // LOGIN, a dead host, our own clock running out — is "could not look", and it must reach the
    // caller as the same 502 the read path's own failures do, never as a raw 500 whose text says
    // nothing anyone can act on. `ServiceError` is matched by NAME rather than by class for the
    // middleware's reason: two copies of the services package must not make the same error
    // unrecognisable.
    if (err instanceof ProfileUnavailableError) throw err;
    // BEFORE the ServiceError passthrough, deliberately: the door's timeout IS a ServiceError,
    // and letting it through would answer 504 where this layer already has "could not look".
    if (!isImapDoorTimeout(err) && err instanceof Error && err.name === "ServiceError") throw err;
    throw new ProfileUnavailableError(
      isImapDoorTimeout(err)
        ? "the mailbox did not answer in time while its saved settings were being read"
        : "the mailbox could not be dialled to read its saved settings",
      { op: "list_profiles", cause: err },
    );
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
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      /**
       * `?counts=1` — the one opt-in on this route. `MailboxDTO.messageCount` is an aggregate
       * over the account's whole `messages` table, and this route is polled: every 30 s per open
       * Cloud tab, every 10 s while Settings → Mailboxes is open — neither reads the count, so
       * computing it unconditionally would put a full scan behind a heartbeat. Strictly `"1"`:
       * `params.has("counts")` or a truthiness read turns the aggregate ON for `?counts=0` and
       * `?counts=false`, the spellings a caller reaches for to turn it off. Not a 400 either:
       * this decides one optional field, and a malformed value must not break the pane that
       * renders the rest.
       */
      const counts = new URL(req.url).searchParams.get("counts") === "1";
      const items = await mailbox(deps).list(serviceContext(deps, req), { counts });
      return jsonResponse({ items });
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes/:id",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await mailbox(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    /**
     * The settings actually in force on a mailbox this install reads (mail 0094). On a mailbox
     * another install organizes, this install's own responder/rules/window/signature rows are not
     * the answer — the ones in force are in the holder's published document, and rendering the
     * local copies shows a reader its own dead rows as though live. `read`, and it means it: one
     * indexed row out of `mailbox_profile_mirror`, written by the reader's own cycle; no IMAP, no
     * per-request dial. The four states (this install organizes / a document is mirrored / a
     * holder known, nothing read / nobody known) are argued in `readMailboxProfile` and must not
     * collapse: an absent document and "this install owns the settings" want different copy.
     */
    method: "GET",
    pattern: "/mailboxes/:id/profile",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const view = await readMailboxProfile(serviceContext(deps, req), params.id!);
      return jsonResponse(view);
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/:id/resync",
    relay: true,
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
    relay: true,
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
    method: "POST",
    pattern: "/mailboxes/:id/organizer-notice/dismiss",
    relay: true,
    // `work`, and no step-up — the `inbound-quiet/dismiss` precedent: one timestamp on the
    // caller's own mailbox row (mail 0088), no socket, no spend, and dismissing a notice about
    // your own mailbox is not a credential act — a second factor here would teach people the
    // notice is dangerous. Naturally idempotent: a repeat press re-stamps the same
    // acknowledgement, and the client's comparison is `eventAt > seenAt`. Mounted on the local
    // door too (`mailboxRoutes`): a standalone install shows the same notice off the same row.
    cost: "work",
    handler: async (req, deps, params) => {
      const dto = await mailbox(deps).dismissOrganizerNotice(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/:id/release",
    relay: true,
    /**
     * `work`, not `connection` — the contrast with `/organize` is the classification: that one
     * may dial (the ceremony can carry a password and proves it against the provider); this opens
     * no socket and can open none — the claim it gives up lives in the customer's IMAP folder,
     * and expunging it is the organizer's next pass. No step-up, stated plainly: a second factor
     * guards the direction that takes control of somebody's mail; this direction gives it up,
     * keeps every credential and message, and is reversible with the button beside it — gating it
     * would lock out exactly the person who lost their second factor. Local twin for free: `POST
     * /local/mailboxes/:id/release`.
     */
    cost: "work",
    handler: async (req, deps, params) => {
      const result = await mailbox(deps).release(serviceContext(deps, req), params.id!);
      // 202 for the one outcome that changed something, and it is an ACCEPTED rather than an OK on
      // purpose: the ceasing has not happened yet. The organizer's next pass is what releases the
      // claim, so a 200 would claim the mailbox had already been let go. `/organize` answers the
      // same way for the same reason.
      return jsonResponse(result, { status: result.outcome === "requested" ? 202 : 200 });
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes/:id/organizer",
    relay: true,
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
    relay: true,
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
    relay: true,
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
    relay: true,
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
    relay: true,
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
     * Test a connection without making one — the action every mailbox form was missing: all
     * fourteen failure sentences were reachable only as the by-product of a create. No `:id`,
     * because there is no mailbox yet; what bounds it is the probe closure built below — the
     * SSRF/port guard, the per-address admission counter, the deadline. A handler that dialled by
     * hand would compile and have none of them, which is why the probe is constructed here, never
     * in the service. `connection`: the whole handler is one dial to a host the caller typed —
     * `read` would put a mail-server dial inside what an unproven address may reach. Step-up for
     * `POST /mailboxes`' reason: the body carries a mailbox password.
     */
    pattern: "/mailboxes/probe",
    relay: true,
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
    relay: true,
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
    relay: true,
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
    relay: true,
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      /* ── `?erase=1` — REMOVE THE MAILBOX AND ERASE OHMAIL'S COPY OF ITS MAIL ────────────
       *
       * Without it this route is the reversible removal it has always been. With it the mailbox's
       * messages, bodies, read state, drafts, folder inventory and cached profile go, and
       * `?confirm=` must repeat the mailbox's own address — the service compares it to the row it
       * is about to erase, so neither a bare flag nor a mistyped id can erase anything. The
       * bound is `RECIPIENT_ADDRESS_MAX_CHARS`: this is an address, read from a URL, and an
       * unbounded query value reaching a comparison is the class `input-bounds-census` closes.
       */
      const query = new URL(req.url).searchParams;
      const erase = query.get("erase") === "1"
        ? { confirmAddress: (query.get("confirm") ?? "").slice(0, RECIPIENT_ADDRESS_MAX_CHARS) }
        : undefined;
      const { seq, erased } = await mailbox(deps)
        .delete(serviceContext(deps, req), params.id!, { erase });
      /* An erasure answers with its receipt rather than a bare 204: the operator's audit trail and
       * the person's own confirmation both read the per-table counts, exactly as `DELETE /account`
       * reports them. A plain removal keeps the 204 it has always answered. */
      if (erased) {
        return jsonResponse({
          erased: true,
          mailboxId: params.id!,
          messagesErased: erased.messagesErased,
          draftsErased: erased.draftsErased,
          draftsUnanchored: erased.draftsUnanchored,
          tables: erased.deleted,
          retained: "nothing for this mailbox; the mail itself stays on your own server",
        }, { seq });
      }
      // The delta contract's echo, on a 204: a removal closes the mailbox's pending scheduled
      // sends — a `draft` change the asking mirror has to apply, so the seq rides `X-Sync-Seq`
      // (absent when nothing was closed). Two residuals, filed rather than hidden. (1) Nothing on
      // the mailbox path consumes the header today: mailbox mutations are the settings pane's own
      // REST calls, and `api<void>` returns at 204 before reading a header — the closed
      // appointment reaches Drafts on the next `/sync` drain. The header stays: it is the
      // contract, free the moment the mailbox family goes through the engine. (2) This route is
      // unkeyed, so a lost 204 cannot be replayed; exactly three mailbox routes spend without a
      // key (this, `POST /mailboxes`, `PATCH /mailboxes/:id`) and all three move together or none
      // does.
      return seq === null
        ? noContent()
        : new Response(null, { status: 204, headers: { "X-Sync-Seq": String(seq) } });
    },
  },
];
