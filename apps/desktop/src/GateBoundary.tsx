/**
 * THE LAST THING BETWEEN A THROW AND A WHITE RECTANGLE. React unmounts the whole tree when a
 * render throws and nothing catches; in an application window that is indistinguishable from
 * still-loading, a broken driver, or lost mail. Not hypothetical: a released build drew
 * exactly that — `DesktopGate` builds the client engine during render, the public repository
 * carried a stand-in whose constructor throws, and the window went white the moment the shell
 * reported a mailbox, after a sign-in that had SUCCEEDED. The publish rule behind it is fixed
 * where it lives; this exists for the NEXT throw out of an engine constructor. The caught
 * error's own message is the reason line — written for whoever wrote the code, but a sentence
 */

/*
 * somebody can quote beats a blank window, and a friendlier invention would discard the only
 * fact anybody has. It wraps the gate FROM OUTSIDE (`main.tsx`) — a boundary cannot catch its
 * own render. Reload rather than "Try again": re-rendering the same tree meets the same throw
 * on the same state; reloading rebuilds the world, and a permanent cause brings the notice
 * straight back, which is the honest answer.
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
