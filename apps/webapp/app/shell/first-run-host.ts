"use client";

/**
 * What the first-run stage asks its door for — the seam, and the only one it has. `app/shell/**` is shared with
 * `apps/desktop`, whose build aliases `app/api-client` to a throwing stub, and it is copied into a public
 * mirror that lacks the module entirely (`scripts/publish-desktop.mjs` denies it) — so the stage cannot import
 * "connect a mailbox" any more than `AppShell` can import "who is signed in"; the pattern is `CloudShell`'s
 * verbatim. Cloud/self-host reach `packages/api` over REST with a session cookie; the standalone desktop
 * reaches the same service code in-process through the sidecar's local door. {@link FirstRunHost.providerForm}
 * is a NODE because the AI provider step exists on the standalone door alone (ruling 2(d)) and its form is
 * `apps/desktop/src/AiProviderForm.tsx`, which `apps/webapp` may not import — a pin asserts that.
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
 * What "agree and start organizing" actually did — two answers, because the stage needs exactly
 * one bit and the doors answer in two vocabularies: Cloud answers
 * `authorized | already_organizing | disconnected`; the standalone door adds `removed` and
 * `no_mailbox`. What the screen has to know is whether the press stored the answer it promised to
 * store; mapping at the host keeps the server's vocabulary out of the stage, as
 * {@link FirstRunHost.probeReason} keeps `ApiError` out. A return value, not an exception: every
 * one of these is a 200 — before this existed the stage treated a press that stored nothing
 * exactly like a press that worked.
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
   * Where this install stands on AI — the four-state posture, resolved by the DOOR because only the
   * door knows where the answer is kept: standalone — the install's own AI file (`ai-provider.ts`),
   * a real choice; cloud — `accounts.ai_enabled`, a boolean that rests false, so this door cannot
   * tell "answered no" from "never asked" and reports `unset` until the flow has been through
   * once (the stage compensates by walking past a "no" on its own cursor); self-host — the
   * operator's key, from `/hello`, nothing for a person to answer.
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
   * Connect it — creates a CONSENT-LESS READER: the mirror starts building, nothing is moved, `ohmail/*` is never
   * created; the stage may say "connected" and may not say "organizing". `mode` is required, and the default it does
   * not have is the point. `"seed"` — the first mailbox of an install; on the standalone door a reconfiguration of
   * the settings file the engine dials from. `"add"` — a further mailbox: `POST /local/mailboxes`, beside the ones
   * already running, never reconfiguring the install. A default picks one for a caller that did not say, and both
   * directions cost a mailbox: defaulted to `seed`, "Add mailbox" replaces the engine and seals the new password onto
   * the original mailbox; defaulted to `add`, a first connect writes a row the install never dials. On the hosted
   * door both words select `POST /mailboxes`; the parameter stays required so the seam has one shape.
   */
  connect: (input: FirstRunMailboxInput, mode: "seed" | "add") => Promise<{ id: string }>;

  /**
   * Agree and start organizing — `POST /mailboxes/:id/organize`, the ONE call the consent and the window both ride.
   * The window cannot be a second request: `screening_baseline_at` is what the window is measured from and the
   * consent is what writes it, so a separate call would leave a gap in which the cutoff is the product default rather
   * than the answer the person just gave — the service writes consent, baseline, window and scope in one transaction.
   * It answers, and the answer is not always "done" ({@link FirstRunOrganizeOutcome}): every reply is a 200, so a
   * `Promise<void>` could not tell a press that worked from one that stored nothing. On a re-run both doors refuse to
   * re-stamp consent (a second press is not a second becoming) and still write the window and scope — `"stored"`,
   * which is why the re-run's window control is not decorative.
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
