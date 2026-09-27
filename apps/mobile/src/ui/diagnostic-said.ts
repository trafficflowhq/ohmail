/**
 * WHAT THE DIAGNOSTIC ROW SAYS, per press state — pure, so the node suite drives every state
 * (there is no React Native renderer in this workspace). The share press is offered only once a
 * file exists, and every sentence after a press says nothing was sent.
 */
import { Copy } from "../copy";
import { readablePath } from "../engine/diagnostics";

export type DiagnosticPress =
  | { k: "rest" }
  | { k: "busy" }
  | { k: "written"; where: string }
  | { k: "share_failed"; where: string }
  | { k: "failed" };

export interface DiagnosticSaid {
  sentence: string;
  action: string;
  busy: boolean;
  /** The file to offer the share sheet for, or null while there is none. */
  share: string | null;
}

export function diagnosticSaid(p: DiagnosticPress): DiagnosticSaid {
  switch (p.k) {
    case "rest": return { sentence: Copy.diagnosticWhy, action: Copy.diagnosticAction, busy: false, share: null };
    case "busy": return { sentence: Copy.diagnosticWhy, action: Copy.diagnosticWriting, busy: true, share: null };
    case "written":
      return { sentence: Copy.diagnosticWritten(readablePath(p.where)), action: Copy.diagnosticAction, busy: false, share: p.where };
    case "share_failed": return { sentence: Copy.diagnosticShareFailed, action: Copy.diagnosticAction, busy: false, share: p.where };
    case "failed": return { sentence: Copy.diagnosticFailed, action: Copy.diagnosticAction, busy: false, share: null };
  }
}
