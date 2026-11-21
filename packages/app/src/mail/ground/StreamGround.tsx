import { useLayoutEffect, useRef, useState, type ContextType, type ReactNode } from "react";
import { StreamVisits } from "@ohmail/app-logic/streams";
import { useDemoMode, useEngine } from "@ohmail/app-logic/engine";
import { PileNoteContext, usePileNote, type PileNoteSaid } from "@ohmail/app-logic/lists/pile-note";
import { useFrame } from "../../frame/index.js";
import { FilingChoiceContext, type FilingChoice } from "../../stream/FilingChip.js";
import { useText } from "../../text/index.js";

/** The pending screen press and whether a pile had a cursor belong to this frame and account across visits. */
export function StreamGround({ children }: { readonly children: ReactNode }) {
  const { route, report } = useFrame();
  const engine = useEngine();
  const visits = useRef<{
    engine: typeof engine;
    piles: NonNullable<ContextType<typeof StreamVisits>>;
  } | null>(null);
  if (visits.current?.engine !== engine) {
    visits.current = { engine, piles: { cursors: new Set(), positions: new Map() } };
  }
  const { positions } = visits.current.piles;
  useLayoutEffect(() => {
    // The other reading pile starts a fresh visit. An Ohbox detour keeps the reading position.
    if (route.place === "news") positions.delete("receipts");
    if (route.place === "receipts") positions.delete("news");
  }, [positions, route.place]);
  const demo = useDemoMode();
  const [filing, setFiling] = useState<{ engine: typeof engine; choice: FilingChoice } | null>(null);
  const filingChoice = {
    choice: filing?.engine === engine ? filing.choice : null,
    choose: (choice: FilingChoice) => setFiling({ engine, choice }),
  };
  const t = useText("screener");
  const say = (said: PileNoteSaid) =>
    report(
      said.kind === "moved"
        ? t("unscreenedMoved", { count: said.count })
        : t(said.kind === "none" ? "unscreenedMovedNone" : "unscreenedFailed"),
    );
  const news = usePileNote(engine, "news", !demo && route.place === "news", say);
  const receipts = usePileNote(engine, "receipts", !demo && route.place === "receipts", say);
  const shown = route.place === "news" ? news : route.place === "receipts" ? receipts : null;
  return (
    <StreamVisits.Provider value={visits.current.piles}>
      <PileNoteContext.Provider value={shown}>
        <FilingChoiceContext.Provider value={filingChoice}>{children}</FilingChoiceContext.Provider>
      </PileNoteContext.Provider>
    </StreamVisits.Provider>
  );
}
