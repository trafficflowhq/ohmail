/**
 * "ohmail cannot open your mailbox" — the one card, for the three ways of arriving at it.
 *
 * The window has exactly one thing to say when there is a mailbox it cannot show, and three
 * places now need to say it: the gate, when the shell reports an engine that is absent, failed or
 * locked out of the keystore; the boot check, when the bridge to the engine cannot be built at
 * all; and the error boundary, when a render throws. They differ only in the sentence and in what
 * the button does, so those are the props and everything else is here once.
 *
 * The footer is not decoration and is the same in all three. Every one of these states is a
 * person looking at an app that will not open their mail, and the first question is whether the
 * mail is all right. It is: this app holds a copy, and the original is on their own server or in
 * their hosted account, neither of which a failure to draw a window has touched.
 */

import type { ReactNode } from "react";
import { Button } from "@ohmail/ui";

import { DOOR_COPY } from "./door-copy.js";

export interface GateNoticeProps {
  /** What went wrong, as one sentence. The only thing the three callers disagree about. */
  reason: string;
  /** The label on the primary action — `desktopDoor.gateTryAgain` or `…reload`. */
  actionLabel: string;
  onAction: () => void;
  /**
   * A SECOND WAY OUT, when the state genuinely has two — and only then.
   *
   * Three of the four callers have exactly one honest remedy and pass nothing here: an engine
   * that will not start is retried, a render that threw is reloaded. The fourth is a paired
   * install whose pairing was revoked, where the two remedies are opposites and the product's
   * whole argument is that the second one exists: pair with that computer again, OR stop
   * depending on it and open the mailbox from here.
   *
   * Offering only the first would make the notice a dead end for anybody whose other machine is
   * gone for good — which is the case the sentence above it is most likely describing.
   */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Anything the caller wants under the action — used for nothing today. */
  children?: ReactNode;
}

export function GateNotice({
  reason,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  children,
}: GateNoticeProps) {
  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark"><b>ohmail</b><em>.</em></span>
        <h1>{DOOR_COPY.gateCannotOpen}</h1>
        <p>{reason}</p>
        <div className="gate-actions">
          <Button onClick={onAction}>{actionLabel}</Button>
          {/* GHOST, so the two do not read as equals. Re-pairing is what most people want and
              keeps everything as it is; setting this machine up on its own discards the copy and
              takes over the organizing, which is a bigger decision and should not be one press
              away from looking like the default. */}
          {secondaryLabel && onSecondary ? (
            <Button variant="ghost" onClick={onSecondary}>{secondaryLabel}</Button>
          ) : null}
        </div>
        {children}
        <p className="gate-foot">{DOOR_COPY.gateFoot}</p>
      </div>
    </div>
  );
}
