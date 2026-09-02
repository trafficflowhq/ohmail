"use client";

/**
 * WHAT THE FIRST-RUN STAGE ASKS ITS DOOR FOR — the seam, and the only one it has.
 *
 * ── WHY THE STAGE TAKES A HOST INSTEAD OF CALLING THE API ─────────────────────────────────
 *
 * `app/shell/**` is SHARED with `apps/desktop`, a standalone AGPL program whose build aliases
 * `app/api-client` to a stub that throws (`apps/desktop/vite.config.ts`), and it is copied into
 * a public mirror that does not contain that module at all
 * (`scripts/publish-desktop.mjs` DENYs it). So the stage cannot import "connect a mailbox" any
 * more than `AppShell` can import "who is signed in" — the pattern here is `CloudShell`'s
 * verbatim, and every method below exists because some door implements it differently:
 *
 *  · Cloud/self-host reach `packages/api` over REST with a session cookie.
 *  · The standalone desktop reaches the SAME service code in-process through the sidecar's
 *    local door, with the launch bearer standing in for "this machine".
 *
 * ── AND WHY {@link FirstRunHost.providerForm} IS A NODE ───────────────────────────────────
 *
 * The AI provider step exists on the standalone door alone (ruling 2(d)), and its form is
 * `apps/desktop/src/AiProviderForm.tsx` — the SAME component `DesktopAiSettings` mounts, so
 * there is one write path to the install's model file and not two. `apps/webapp` may not import
 * it, and a pin asserts that it does not; the desktop passes the node in. On the other two doors
 * the field is absent and the step renders the door's own sentence instead.
 */

import type { ReactNode } from "react";
import type { OnboardingAi, OnboardingDoor } from "./onboarding";

/** What a successful `POST /mailboxes/probe` answers with. */
export interface FirstRunProbeOk {
  /** The host that ANSWERED — the proven rung, which is not always the one that was typed. */
  host: string;
  /** The identity the server accepted. */
  user: string;
  /**
   * How many folders the LIST returned, or `null` when the probe was built without the count.
   *
   * `null` is rendered as a verdict with no number rather than as "0 folders": a greeting and an
   * accepted login prove the host, the port, the TLS mode and the password, and say nothing
   * about whether the account can read anything. The count is the part that is checkable.
   */
  folders: number | null;
}

/** What the form has typed so far, as both the probe and the create want it. */
export interface FirstRunMailboxInput {
  address: string;
  provider: string;
  imap: { host: string; port?: number; secure?: boolean; user?: string; pass: string };
  smtp?: { host: string; port?: number; secure?: boolean; user?: string; pass?: string };
}

/**
 * WHAT "AGREE AND START ORGANIZING" ACTUALLY DID — two answers, because the stage needs exactly
 * one bit and the doors answer it in two different vocabularies.
 *
 * Cloud answers `authorized | already_organizing | disconnected`; the standalone door adds
 * `removed` and `no_mailbox`. None of those distinctions mean anything to a screen — what the
 * screen has to know is whether the press stored the answer it promised to store. Mapping at the
 * host keeps the server's vocabulary out of the stage, the same way {@link FirstRunHost.probeReason}
 * keeps `ApiError` out of it.
 *
 * IT IS A RETURN VALUE AND NOT AN EXCEPTION because none of these is an error: every one of them
 * is a 200. Before this existed the stage could not tell them apart at all and treated a press
 * that stored nothing exactly like a press that worked.
 */
export type FirstRunOrganizeOutcome =
  /**
   * The answer is stored: consent is recorded (it may already have been) and the window and
   * scope this call carried are on the account. The flow may go on.
   */
  | "stored"
  /**
   * There was nothing to organize — the mailbox is disconnected, removed, or unknown to this
   * door. NOTHING was written, so the flow may not advance and must say so.
   */
  | "gone";

export interface FirstRunHost {
  /** Which door is asking — it decides which steps exist at all (see {@link OnboardingDoor}). */
  door: OnboardingDoor;

  /**
   * WHERE THIS INSTALL STANDS ON AI — the four-state posture, resolved by the DOOR because only
   * the door knows where the answer is kept.
   *
   *  · standalone — the install's own AI file (`ai-provider.ts`), which records a real choice;
   *  · cloud      — `accounts.ai_enabled`, a BOOLEAN that rests false, so this door genuinely
   *                 cannot tell "answered no" from "never asked" and reports `unset` until the
   *                 flow has been through once. The stage compensates by walking past a "no"
   *                 on its own cursor rather than by re-deriving into the same question; see
   *                 the AI step.
   *  · self-host  — the operator's key, from `/hello`. Nothing here for a person to answer.
   */
  ai: OnboardingAi;

  /**
   * TEST THIS CONNECTION — `POST /mailboxes/probe`. Resolves on success, THROWS on every
   * failure, and the throw is the same `mailbox_probe_failed` shape `POST /mailboxes` produces.
   *
   * That sameness is by construction on the server (`probeConnection` sits beside `create` and
   * throws the same `probeRefused`), and it is why this surface needs no failure copy of its
   * own: {@link probeReason} classifies the error into the taxonomy the connect form already
   * renders. Only SUCCESS is new, because nothing in this product could previously produce one.
   */
  probe: (input: FirstRunMailboxInput) => Promise<FirstRunProbeOk>;

  /**
   * CONNECT IT — creates a CONSENT-LESS READER: the mirror starts building, nothing is moved, and
   * `ohmail/*` is never created. The stage may say "connected" truthfully at this point and may
   * not say "organizing".
   *
   * ── `mode` IS REQUIRED, AND THE DEFAULT IT DOES NOT HAVE IS THE POINT ─────────────────────
   *
   *  · `"seed"` — the FIRST mailbox of an install. On the standalone door this is not a request
   *    at all but a reconfiguration: the shell's settings file is what the engine composes its
   *    IMAP dial from at every launch, so a row created any other way would be a row nothing
   *    ever connects to.
   *  · `"add"` — a FURTHER mailbox on an install that already has one. It is a request:
   *    `POST /local/mailboxes`, which writes the row and its credential beside the ones already
   *    running and attaches a runtime for it. It must never reconfigure the install.
   *
   * A default would pick one of those for a caller that did not say, and both directions are
   * wrong in a way that costs a mailbox. Defaulted to `seed`, "Add mailbox" replaces the engine
   * and the first-connect order then seals the newly typed password onto the row the REPLACED
   * engine settles on — the install's original mailbox. Defaulted to `add`, a first connect
   * writes a row the shell has never heard of and the install dials nothing.
   *
   * On the hosted door both words select the same call (`POST /mailboxes`), because there is no
   * settings file and no engine to reconfigure; the parameter is still required there, so that
   * the seam has one shape and a caller cannot learn a habit that is wrong on the other door.
   */
  connect: (input: FirstRunMailboxInput, mode: "seed" | "add") => Promise<{ id: string }>;

  /**
   * AGREE AND START ORGANIZING — `POST /mailboxes/:id/organize`, and the ONE call the consent
   * and the window both ride.
   *
   * The window cannot be a second request. `screening_baseline_at` is what the window is
   * measured from and the consent is what writes it, so a separate "set the window" call would
   * leave a gap in which the baseline exists and the window does not — and during that gap the
   * cutoff is the product default, not the answer the person just gave. The service writes
   * consent, baseline, window and scope in one transaction; this method is the door to it.
   *
   * ── IT ANSWERS, AND THE ANSWER IS NOT ALWAYS "DONE" ──────────────────────────────────────
   *
   * See {@link FirstRunOrganizeOutcome}. Every reply is a 200, including the ones that store
   * nothing, so a `Promise<void>` gave the stage no way to tell a press that worked from a press
   * that could not — and it advanced either way.
   *
   * On a RE-RUN of setup the mailbox is usually already organized with consent recorded. Both
   * doors refuse to re-stamp it (a second press is not a second becoming) and both still write
   * the window and the scope, because those are the answer the person just gave. That is
   * `"stored"`, and it is why the re-run's window control is not decorative.
   */
  organize: (
    mailboxId: string,
    body: { imap?: { pass: string }; screening?: { dormancyDays?: number; scope?: "window" | "all_time" } },
  ) => Promise<FirstRunOrganizeOutcome>;

  /**
   * LEAVE THE FLOW — `PATCH /consent/settings { onboardingCompleted: true }`.
   *
   * Cancel and finish both call it, which is what lets ONE truth-condition close the flow for
   * both. It takes only `true`: nothing un-completes onboarding.
   */
  complete: () => Promise<void>;

  /**
   * THE AI ANSWER, where the door has a switch to write it to. Absent on a door where AI is the
   * operator's to configure (self-host), and the step renders a read-only sentence there.
   */
  setAiEnabled?: (enabled: boolean) => Promise<void>;

  /**
   * FORGET THE MAILBOX — the "Start over" verb's second answer, `DELETE /mailboxes/:id`.
   *
   * OPTIONAL, and its absence is why "Start over" can offer one option instead of two: a door
   * with no removal route may still restart the flow keeping the mailbox, which is the answer
   * most people want anyway. Offering a "forget it" button that no door implements would be a
   * control that lies about having acted — the failure this whole flow's copy is written against.
   */
  forgetMailbox?: (mailboxId: string) => Promise<void>;

  /**
   * WHICH MEMBER OF THE PROBE TAXONOMY THIS ERROR IS — `auth` · `connect` · `tls` · `timeout` ·
   * `storage` · `sync` · `unknown` — or `null` when it is not a probe refusal at all.
   *
   * Injected rather than imported for the module reason at the top of this file: the classifier
   * reads `ApiError`, which lives in `app/api-client`. A `null` answer falls back to the
   * server's own sentence, which is always true even when this build has no copy for it.
   */
  probeReason: (err: unknown) => string | null;
  /** The server's own sentence for an error, for the fallback the line above describes. */
  probeMessage: (err: unknown) => string | null;

  /**
   * THE STANDALONE DOOR'S AI PROVIDER FORM, injected. See the header. Absent everywhere else.
   */
  providerForm?: ReactNode;

  /**
   * WHETHER THIS SELF-HOST SERVER HAS AN AI KEY — read from `/hello`'s capabilities, read-only.
   * `undefined` on every other door, where the question is not this one's to answer.
   */
  selfhostAi?: boolean;

  /**
   * THE PAIRING PANEL — the devices surface's own node (QR + the same-network switch). Absent
   * where the door does not pair, and the step is then skipped rather than rendered empty.
   */
  pairNode?: ReactNode;
}
