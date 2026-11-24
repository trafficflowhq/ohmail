export type PhoneDiagnosticRequest =
  | { readonly do: "write"; readonly counts: readonly number[] }
  | { readonly do: "share" };

type DiagnosticAnswer =
  | { readonly fileName: string }
  | { readonly shared: boolean }
  | { readonly refused: "cancelled" | "notReady" };

interface DiagnosticDoors {
  readonly live: () => boolean;
  readonly fileName: string;
  readonly write: (counts: readonly number[], allowed: () => boolean, signal: AbortSignal) => Promise<string | null>;
  readonly share: (uri: string, allowed: () => boolean) => Promise<boolean>;
}

export interface PhoneDiagnosticsDoor {
  beginPage(): void;
  answer(request: PhoneDiagnosticRequest, signal: AbortSignal): Promise<DiagnosticAnswer>;
}

/** The current native page keeps the file path. A new page or session must write its own file. */
export function createPhoneDiagnosticsDoor(deps: DiagnosticDoors): PhoneDiagnosticsDoor {
  const newPage = (): { uri: string | null; busy: boolean } => ({ uri: null, busy: false });
  let page = newPage();
  return {
    beginPage() {
      page = newPage();
    },
    async answer(request, signal) {
      const current = page;
      const allowed = () => page === current && !signal.aborted && deps.live();
      if (!allowed()) return { refused: "cancelled" };
      if (current.busy) return { refused: "notReady" };

      current.busy = true;
      try {
        if (request.do === "share") {
          if (current.uri === null) return { refused: "notReady" };
          const shared = await deps.share(current.uri, allowed).catch(() => false);
          return allowed() ? { shared } : { refused: "cancelled" };
        }
        current.uri = null;
        const uri = await deps.write(request.counts, allowed, signal).catch(() => null);
        if (!allowed()) return { refused: "cancelled" };
        if (uri === null) return { refused: "notReady" };
        current.uri = uri;
        return { fileName: deps.fileName };
      } finally {
        current.busy = false;
      }
    },
  };
}
