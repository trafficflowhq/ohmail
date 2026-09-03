/**
 * THE LAST THING BETWEEN A THROW AND A WHITE RECTANGLE.
 *
 * React unmounts the whole tree when a render throws and nothing above it catches. In a browser
 * tab that is survivable — the address bar is still there and reload is one key — but this is an
 * application window, and an application window with nothing in it is indistinguishable from one
 * that is still loading, from a broken graphics driver, and from an app that has silently lost
 * somebody's mail. There is no way in and nothing to read.
 *
 * That is not hypothetical. A released build of this app drew exactly that: `DesktopGate` builds
 * the client engine during the render that first needs one, the public repository it was compiled
 * from carried a stand-in whose constructor throws, and so the window went white the moment the
 * shell reported a mailbox — after a sign-in that had actually SUCCEEDED, with the mail already
 * pulled onto the machine. The publish rule that caused it is fixed, and asserted where it lives.
 * This exists because the NEXT throw out of an engine constructor — an adapter that starts
 * validating its options, a store that refuses a migration — would otherwise be the same white
 * rectangle, and the person in front of it would have the same nothing to go on.
 *
 * ── WHAT IT PUTS ON SCREEN, AND WHY IT IS THE DEVELOPER'S SENTENCE ──────────────────────────
 *
 * The caught error's own message is the reason line. It is written for whoever wrote the code
 * rather than for whoever is reading it, which is worth saying out loud — but a sentence somebody
 * can quote in a bug report beats a blank window, and inventing a friendlier one would mean
 * discarding the only fact anybody has.
 *
 * ── IT WRAPS THE GATE FROM OUTSIDE, WHICH IS THE ONLY PLACE IT CAN ──────────────────────────
 *
 * A boundary is a component and a component cannot catch its own render. Putting this inside
 * `DesktopGate` would leave it sharing an instance with the call that throws, and it would never
 * fire. So it goes around it, in `main.tsx`.
 *
 * Reload rather than "Try again": a boundary that re-renders the same tree meets the same throw
 * on the same state, and a button that does nothing twice is worse than no button. Reloading
 * rebuilds the whole world, which is the only recovery that can actually differ — and when the
 * cause is permanent the notice comes straight back, which is the honest answer.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { DOOR_COPY } from "./door-copy.js";
import { GateNotice } from "./GateNotice.js";

interface Props {
  children: ReactNode;
  /** Told about every catch, so a failure that blanks the window is not also a silent one. */
  onError?: (error: unknown) => void;
  /** Overridable so a test can assert the recovery without reloading its own runner. */
  reload?: () => void;
}

interface State {
  message: string | null;
}

export class GateBoundary extends Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: errorSentence(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    /* Kept, because the log is the only place the component stack survives — the card has room
       for one sentence and this is the rest of it. */
    console.error("ohmail: the window could not draw", error, info.componentStack);
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <GateNotice
        reason={this.state.message}
        actionLabel={DOOR_COPY.reload}
        onAction={this.props.reload ?? (() => location.reload())}
      />
    );
  }
}

/** Whatever was thrown, as something a person can put in a message to somebody else. */
export function errorSentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || DOOR_COPY.errorUnknown;
}
