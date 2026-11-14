import { useCallback, useEffect, useRef, useState } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { BearerManager } from "./bearer.js";
import { createHostClientEngine } from "./host-engine.js";

export function usePairedEngine(bearer: BearerManager) {
  /**
   * ONE engine per pairing, built only once this browser holds one. `paired` is the dependency
   * that matters: a re-pair after a death builds a fresh engine rather than reviving one whose
   * in-flight drains were refused.
   */
  /**
   * WHICH PAIRING THIS PAGE IS SERVING — read every render, because a re-pair changes it under us.
   *
   * `paired` is a boolean and `bearer` is one long-lived object, so neither of them CHANGES when a
   * `/pair` redeem swaps the credential while the tab is already paired — the explicitly supported
   * gesture one branch below. The engine memo therefore kept account A's in-memory mirror and
   * served it under account B's session: two accounts' mail in one mirror, which is the
   * cross-account lesson this door's own header cites as the reason it has no persistent one.
   */
  const scope = bearer.pairScope();
  const [mirror, setMirror] = useState<{
    bearer: BearerManager;
    scope: string | null;
    account: string;
  } | null>(null);
  const mirrorAccount = mirror?.bearer === bearer && mirror.scope === scope ? mirror.account : null;

  /** WHICH PAIRING THIS BROWSER SAID IT CANNOT KEEP CHANGES FOR — said once, dismissible. */
  const [unkept, setUnkept] = useState<{ scope: string | null; dismissed: boolean } | null>(null);

  const makeEngine = useCallback(
    (bearer: BearerManager, scope: string | null) =>
      createHostClientEngine(bearer, {
        scope,
        onMirrorAccount: (account) =>
          setMirror((current) =>
            current?.bearer === bearer && current.scope === scope && current.account === account
              ? current
              : { bearer, scope, account },
          ),
        onUnkept: () => setUnkept((u) => (u !== null && u.scope === scope ? u : { scope, dismissed: false })),
      }),
    [],
  );
  return { scope, makeEngine, mirrorAccount, unkept, setUnkept };
}

export function useReplacePairedEngine(engine: OhmailEngine | null): void {
  /* AN ENGINE THE PAGE REPLACES LETS GO OF ITS OUTBOX ROWS (`OhmailEngine.dispose`), so the next one
     adopts them. Disposed when the memo moves on, never in the effect's own cleanup: StrictMode
     replays that cleanup over the engine still in use. */
  const previous = useRef<OhmailEngine | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== engine) previous.current.dispose();
    previous.current = engine;
  }, [engine]);
}
