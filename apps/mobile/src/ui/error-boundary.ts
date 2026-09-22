/**
 * A RENDER ERROR IS CAUGHT, NOT FATAL. React Native hands an uncaught render throw to
 * `RCTExceptionsManager.reportFatal`, which aborts a release build — 23 of 27 crash reports on the
 * build Mac were one `TypeError` taking that road. A boundary turns the throw into a sentence with
 * Retry and writes ONE line through the app's one sink. This is the pure half — the line, the
 * surface names, the class — with no React Native in it, so the node suite drives it as functions;
 * `ErrorBoundary.tsx` draws the fallback. The line carries, by construction: the error's CLASS
 * (identifier grammar), its MESSAGE (addresses and digit runs replaced, bounded) and the FIRST
 * component frame's NAME. A thrown non-Error is named by type, never serialized — it could be mail.
 */
import { Component, createElement, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Copy } from "../copy";
import { engineLogSink, type EngineLogSink } from "../engine/engine-log";

/** Every boundary names the surface it guards; the closed set is what the census reads. */
export const SURFACES = [
  "shell", "reader", "composer",
  "ohbox", "screener", "reads", "receipts", "more",
  "settings", "history", "scheduled", "triage", "trash", "drafts", "folder", "away",
  "servers", "scan", "connect", "welcome", "standalone", "search",
] as const;
export type Surface = (typeof SURFACES)[number];

export const RENDER_ERROR_EVENT = "render_error_caught";
export const RENDER_ERROR_SERVICE = "phone";
/** The message's ceiling, in characters — enough to name a defect, too short to carry a body. */
export const MAX_ERROR_TEXT = 200;

const CLASS_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
/* React lists the innermost frame first; both spellings React has used ("in X", "at X") match. */
const FIRST_FRAME_RE = /^\s*(?:in|at)\s+([A-Za-z_$][A-Za-z0-9_$.]{0,63})/m;
const ADDRESS_RE = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g;
const DIGIT_RUN_RE = /\d{6,}/g;

export interface CaughtRenderError {
  errorClass: string;
  errorText: string;
  frame: string | null;
}

/** A free-text message, made safe for a log line: no address, no long number, bounded. */
export function scrubErrorText(text: string): string {
  const scrubbed = text.replace(ADDRESS_RE, "[address]").replace(DIGIT_RUN_RE, "[digits]");
  return scrubbed.length > MAX_ERROR_TEXT ? `${scrubbed.slice(0, MAX_ERROR_TEXT)}…` : scrubbed;
}

function classOf(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || "Error";
    return CLASS_RE.test(name) ? name : "invalid_class";
  }
  if (err === null) return "Null";
  const t = typeof err;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function textOf(err: unknown): string {
  if (err instanceof Error) return scrubErrorText(err.message);
  if (typeof err === "string") return scrubErrorText(err);
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  // An object, a function, a symbol, undefined, null: named by type, never printed.
  return `[${err === null ? "null" : typeof err}]`;
}

/** The innermost component's NAME — never the location in parentheses, which is a file path. */
export function firstFrame(componentStack: string | null | undefined): string | null {
  if (!componentStack) return null;
  const m = FIRST_FRAME_RE.exec(componentStack);
  return m ? m[1] : null;
}

export function describeCaught(err: unknown, componentStack: string | null | undefined): CaughtRenderError {
  return { errorClass: classOf(err), errorText: textOf(err), frame: firstFrame(componentStack) };
}

/** The engine's own line shape: `ts`, `level`, `service`, `event`, then the payload. */
export function renderErrorLine(surface: Surface, caught: CaughtRenderError, now: () => Date = () => new Date()): string {
  return JSON.stringify({
    ts: now().toISOString(),
    level: "error",
    service: RENDER_ERROR_SERVICE,
    event: RENDER_ERROR_EVENT,
    surface,
    errorClass: caught.errorClass,
    errorText: caught.errorText,
    ...(caught.frame === null ? {} : { frame: caught.frame }),
  });
}

/** One line per catch, through the sink every other line of this app leaves by. */
export function noteRenderError(
  surface: Surface,
  err: unknown,
  componentStack: string | null | undefined,
  sink: EngineLogSink = engineLogSink(),
  now: () => Date = () => new Date(),
): void {
  sink(renderErrorLine(surface, describeCaught(err, componentStack), now));
}

/** The surface's name in the person's language — read at render, so a language switch moves it. */
export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "shell": return Copy.renderErrorSurfaceShell;
    case "reader": return Copy.renderErrorSurfaceReader;
    case "composer": return Copy.renderErrorSurfaceComposer;
    case "ohbox": return Copy.ohbox;
    case "screener": return Copy.screener;
    case "reads": return Copy.reads;
    case "receipts": return Copy.receipts;
    case "more": return Copy.tabMore;
    case "settings": return Copy.settings;
    case "history": return Copy.history;
    case "scheduled": return Copy.scheduled;
    case "triage": return Copy.triage;
    case "trash": return Copy.trashTitle;
    case "drafts": return Copy.draftsTitle;
    case "folder": return Copy.folders;
    case "away": return Copy.awayTitle;
    case "servers": return Copy.serversTitle;
    case "scan": return Copy.scanTitle;
    case "connect": return Copy.connectTitle;
    case "standalone": return Copy.doorPhone;
    case "search": return Copy.search;
    case "welcome": return Copy.renderErrorSurfaceScreen;
  }
}

export interface FallbackProps {
  surface: Surface;
  /** Remounts the guarded subtree — a key bump, so every child starts from scratch. */
  onRetry: () => void;
}

export interface BoundaryProps {
  surface: Surface;
  children: ReactNode;
  renderFallback: (p: FallbackProps) => ReactNode;
  sink?: EngineLogSink;
  now?: () => Date;
}

export interface BoundaryState {
  failed: boolean;
  /** Bumped by Retry; the children render under a Fragment keyed on it, which is the remount. */
  generation: number;
}

/** Retry's whole rule: the failure is cleared and the generation moves, so the subtree remounts. */
export function retried(s: BoundaryState): BoundaryState {
  return { failed: false, generation: s.generation + 1 };
}

/**
 * The class React requires for a boundary. It holds no copy and draws nothing: the fallback is
 * the caller's, so this file stays free of React Native and the node suite can drive it.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, generation: 0 };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    noteRenderError(this.props.surface, error, info.componentStack, this.props.sink, this.props.now);
  }

  retry = (): void => {
    this.setState(retried);
  };

  override render(): ReactNode {
    if (this.state.failed) {
      return this.props.renderFallback({ surface: this.props.surface, onRetry: this.retry });
    }
    return createElement(Fragment, { key: this.state.generation }, this.props.children);
  }
}
