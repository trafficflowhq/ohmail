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
    pattern: "/mailboxes/:id/takeover",
    // `work`: it writes, and what it enqueues is the worker becoming the organizer of a real
    // mailbox on its next pass. Step-up for the same reason `POST /mailboxes` carries it — this
    // decides who moves somebody's mail.
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      // NO IMAP. Deliberately, and asserted by a test: organization lands in real folders and the
      // worker is what puts it there, so this writes a stamp and returns. A confirm that dialled
      // would be a second organizer deciding things in a serverless function.
      const result = await mailbox(deps).takeover(serviceContext(deps, req), params.id!);
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
      return seq === null
        ? noContent()
        : new Response(null, { status: 204, headers: { "X-Sync-Seq": String(seq) } });
    },
  },
];
