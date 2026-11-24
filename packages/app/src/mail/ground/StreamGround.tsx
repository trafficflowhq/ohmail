import { useLayoutEffect, useRef, type ContextType, type ReactNode } from "react";
import { reportScreened } from "@ohmail/app-logic/screener";
import { StreamVisits } from "@ohmail/app-logic/streams";
import { useDemoMode, useEngine } from "@ohmail/app-logic/engine";
import {
  PileNoteContext,
  pileOrganizer,
  usePileNote,
  type PileNoteSaid,
} from "@ohmail/app-logic/lists/pile-note";
import { useFrame } from "../../frame/index.js";
import { useMailState } from "@ohmail/app-logic/mail-state/mail-state-binding";
import { useText } from "../../text/index.js";

/** The pending screen press and whether a pile had a cursor belong to this frame and account across visits. */
export function StreamGround({ children }: { readonly children: ReactNode }) {
  const { route, report, host } = useFrame();
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
  const { mailboxes } = useMailState();
  const organizer = pileOrganizer(mailboxes, host.capabilities.service === "managed");
  const t = useText("screener");
  const say = (said: PileNoteSaid) => {
    if (said.kind === "failed") report(t("unscreenedFailed"));
    else reportScreened(report, t, said.kind === "moved" ? said.count : 0, organizer);
  };
  const scope = demo ? null : host.session.scope;
  const news = usePileNote(engine, "news", !demo && route.place === "news", say, scope);
  const receipts = usePileNote(engine, "receipts", !demo && route.place === "receipts", say, scope);
  const shown = route.place === "news" ? news : route.place === "receipts" ? receipts : null;
  return (
    <StreamVisits.Provider value={visits.current.piles}>
      <PileNoteContext.Provider value={shown}>{children}</PileNoteContext.Provider>
    </StreamVisits.Provider>
  );
}
