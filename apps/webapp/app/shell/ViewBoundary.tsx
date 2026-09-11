"use client";

import { Component, type ReactNode } from "react";

/**
 * A per-view error boundary — a render throw inside one pile stays inside that pile. Without it, a
 * throw in any view's render (a windowed list looping to "Maximum update depth exceeded", a stale
 * record reaching an assumed field) unwinds to Next's root and paints the whole tab as the
 * "Application error" page — rail, sync strip and every way out gone. This catches one level below
 * the shell chrome, so the failure degrades to an in-pane card while the rail stays alive; moving to
 * another pile resets the boundary, because the shell keys it on the active view. A class because
 * error boundaries can only be class components; it renders children verbatim until one throws.
 */
export class ViewBoundary extends Component<
  {
    /** Rendered in place of the children once a child render has thrown. */
    fallback: ReactNode;
    children: ReactNode;
    /** Told what was caught — for a log line, never for control flow. */
    onError?: (error: unknown) => void;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
