"use client";

import { Component, type ReactNode } from "react";

/**
 * A PER-VIEW ERROR BOUNDARY — a render throw inside one pile stays inside that pile.
 *
 * The stage renders exactly one view at a time (`effectiveView`). Without a boundary, a throw in
 * any view's render — a windowed list looping to "Maximum update depth exceeded", a stale
 * persisted record reaching a field a view assumes present — unwinds all the way to Next's root
 * and paints the whole tab as the client-side "Application error" page: the rail, the sync strip
 * and every way out gone with it. This catches that throw one level below the shell chrome, so
 * the failure degrades to an in-pane card while the rail stays alive and the reader can navigate
 * to another pile — which resets the boundary, because the shell keys it on the active view.
 *
 * It is a class because `getDerivedStateFromError`/`componentDidCatch` have no hook equivalent;
 * error boundaries can only be class components. It renders its children verbatim until one of
 * them throws, then the fallback, and never touches anything else on screen.
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
