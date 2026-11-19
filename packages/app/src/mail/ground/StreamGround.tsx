import { useMemo, type ReactNode } from "react";
import { StreamCursorVisits, type StreamPlace } from "@ohmail/app-logic/streams";
import { useDemoMode, useEngine } from "@ohmail/app-logic/engine";
import { PileNoteContext, usePileNote, type PileNoteSaid } from "@ohmail/app-logic/lists/pile-note";
import { useFrame } from "../../frame/index.js";
import { useText } from "../../text/index.js";

/** The pending screen press and whether a pile had a cursor belong to this frame and account across visits. */
export function StreamGround({ children }: { readonly children: ReactNode }) {
  const { route, report } = useFrame();
  const engine = useEngine();
  const visits = useMemo(() => new Set<StreamPlace>(), [engine]);
  const demo = useDemoMode();
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
    <StreamCursorVisits.Provider value={visits}>
      <PileNoteContext.Provider value={shown}>{children}</PileNoteContext.Provider>
    </StreamCursorVisits.Provider>
  );
}
