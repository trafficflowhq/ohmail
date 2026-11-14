"use client";

/**
 * THE CONSENT ROW'S MOUNT ABOVE THE PANES: the row's one call for a mounted frame, provided to every place
 * (`useConsent()`). It asks the host's consent wire and no other, under the host's scope, and rests where the host
 * answers none: pictures and pixels blocked, nothing bought, no folder shown. The row's resurface hour, with its
 * writer, it hands to the frame's room.
 */
import { useMemo, type ReactNode } from "react";
import { ConsentContext, useConsentRow, type ConsentTransport } from "@ohmail/app-logic/consent";
import { useRecordWhileSame } from "@ohmail/app-logic/press/stable-callback";
import { useDerivedVersion, useEngine, useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useFrame, useRoomResurface } from "../../frame/index.js";
import { NONE, type None } from "../../host/index.js";

export function ConsentMount({ children }: { readonly children: ReactNode }): ReactNode {
  const { host } = useFrame();
  const engine = useEngine();
  const derived = useDerivedVersion();
  const { mailboxes: facts } = useMailState();
  /* The browser's own answer, never the flag a page was served with: the row asks a wire. */
  const active = !useResolvedDemoMode();
  const wire = host.wires.consent;
  const foldersStorable = host.capabilities.foldersStorable;
  /* The wire as the row's hook takes it: the host's own verbs, with the one fact the contract says beside them
     (whether folders can be stored is a capability). The one cast: the contract names the wire's answers opaquely. */
  const transport = useMemo(
    (): ConsentTransport | None =>
      wire === NONE ? NONE : ({ ...wire, foldersStorable } as unknown as ConsentTransport),
    [wire, foldersStorable],
  );
  /* The row its readers are handed: the one last answered, kept while no field and no writer of it moved. The hook
     answers a new object at every render of this mount (the mirror's stamp and the mail state move it often); a reader
     renders when the row does. */
  const row = useRecordWhileSame(
    useConsentRow({ engine, derived, facts, active, scope: host.session.scope, transport }),
  );
  /* The account's resurface hour is the row's: the reading column books a return at it, and keeps a new one, through
     the frame's room. In the demo's invented world nothing is kept. */
  useRoomResurface({ stored: row.resurfaceTime, store: active ? row.setResurfaceTime : null });
  return <ConsentContext.Provider value={row}>{children}</ConsentContext.Provider>;
}
