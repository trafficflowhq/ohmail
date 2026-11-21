import { EVIDENCE_WINDOW_MS } from "@ohmail/client-engine";
import type { JudgedReadPhase } from "./stream-read-types.js";
import { documentHidden } from "../session/document-hidden.js";
import { STREAM_REST_MS, STREAM_SNIPPET_REST_MS, type StreamLook, type StreamReadRule } from "./read-rule.js";

/** Run the pending-body clock only while the viewport can be attended. */
export function watchPreviewDwell(
  doc: Document,
  measure: () => StreamLook,
  now: () => number,
  rule: StreamReadRule,
  {
    blocked,
    judgement,
    correction,
    flying,
    write,
  }: {
    blocked: () => boolean;
    judgement: {
      phase(): JudgedReadPhase | null;
      settle(): void;
      suspend(): void;
    };
    correction: () => number;
    flying: () => boolean;
    write: (ids: readonly string[]) => void;
  },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let enteredAt = Number.NEGATIVE_INFINITY;
  const attended = (): boolean =>
    !documentHidden() && (doc.hasFocus() || now() - enteredAt <= EVIDENCE_WINDOW_MS);
  const clear = (): void => {
    clearTimeout(timer);
    rule.previewDwell(null);
  };
  const currentShift = () => (judgement.phase() !== null && !flying() ? correction() : 0);
  const stable = () => !blocked() || currentShift() !== 0;
  const read = (look: StreamLook): void => {
    // The anchor's pending correction keeps the same lines in a judged scroll's viewport.
    const shift = currentShift();
    const view = shift === 0 ? look : { ...look, scrollTop: look.scrollTop + shift };
    if (!attended()) {
      lostAttention();
      return;
    }
    const phase = judgement.phase();
    write(rule.previewDwell(view, phase));
    const foot = view.scrollTop + view.viewHeight;
    if (
      phase === "landing" &&
      view.items.some((item) => item.height > 0 && item.top + item.height > view.scrollTop && item.top < foot)
    )
      judgement.settle();
  };
  const arm = (): void => {
    clearTimeout(timer);
    const due = rule.previewDue;
    if (due === null) return;
    timer = setTimeout(
      () => {
        if (stable()) read(measure());
        arm();
      },
      Math.max(stable() ? 1 : 16, Math.ceil(due - now())),
    );
  };
  const lostAttention = (): void => {
    judgement.suspend();
    clear();
  };
  const visibility = (): void => {
    if (!attended()) lostAttention();
  };
  doc.addEventListener("visibilitychange", visibility);
  return {
    attended,
    entered: () => {
      enteredAt = now();
    },
    blurred: () => {
      enteredAt = Number.NEGATIVE_INFINITY;
      lostAttention();
    },
    observe(look?: StreamLook): void {
      if (!stable()) return;
      read(look ?? measure());
      arm();
    },
    clear,
    stop(): void {
      clear();
      doc.removeEventListener("visibilitychange", visibility);
    },
  };
}

/** Check the resting cursor at the body and snippet dwell thresholds. */
export function watchStreamRest(rest: (snippet: boolean) => void) {
  let body: ReturnType<typeof setTimeout> | undefined;
  let snippet: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    clearTimeout(body);
    clearTimeout(snippet);
  };
  return {
    arm(): void {
      clear();
      body = setTimeout(() => rest(false), STREAM_REST_MS);
      snippet = setTimeout(() => rest(true), STREAM_SNIPPET_REST_MS);
    },
    clear,
  };
}
