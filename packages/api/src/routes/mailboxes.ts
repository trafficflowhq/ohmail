import type { CreateMailboxBody, UpdateMailboxBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { makeImapProbe, makeSmtpProbe } from "../imap-probe.js";
import { makeOrganizerPeek } from "../organizer-peek.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { mailbox, readBody, noContent } from "./shared.js";

/**
 * §5.1 — mailboxes READ + RESYNC + the Phase-2a lifecycle mutations. POST/PATCH/
 * DELETE are step-up-gated (recent 2FA) — they carry envelope-encrypted credentials
 * that are encrypted on write and NEVER echoed. DTOs never carry credentials (RC1).
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
      await mailbox(deps).delete(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
