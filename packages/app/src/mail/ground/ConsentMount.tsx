"use client";

/**
 * THE CONSENT ROW'S MOUNT ABOVE THE PANES: the row's one call for a mounted frame, provided to every place
 * (`useConsent()`). It asks the host's consent wire and no other, under the host's scope, and rests where the host
 * answers none: pictures and pixels blocked, nothing bought, no folder shown.
 */
import { useMemo, useRef, type ReactNode } from "react";
import {
  ConsentContext,
  useConsentRow,
  type ConsentRow,
  type ConsentTransport,
} from "@ohmail/app-logic/consent";
import { useDerivedVersion, useEngine, useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../../frame/index.js";
import { NONE, type None } from "../../host/index.js";

const sameMembers = (a: ConsentRow, b: ConsentRow): boolean => {
  const keys = Object.keys(a) as (keyof ConsentRow)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
};

/**
 * The row its readers are handed: the one last answered, kept while no field and no writer of it moved. The hook
 * answers a new object at every render of this mount (the mirror's stamp and the mail state move it often); a reader
 * renders when the row does.
 */
function useRowWhileSame(row: ConsentRow): ConsentRow {
  const held = useRef(row);
  if (!sameMembers(held.current, row)) held.current = row;
  return held.current;
}

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
  const row = useRowWhileSame(
    useConsentRow({ engine, derived, facts, active, scope: host.session.scope, transport }),
  );
  return <ConsentContext.Provider value={row}>{children}</ConsentContext.Provider>;
}
