/**
 * The gate, rendered — the one component that turns `gateFor`'s verdict into a surface. Both
 * mail groups wrap themselves in this: the tabs layout AND the pushed mail detail routes
 * (`app/(mail)/_layout.tsx`). The second wrap exists because a deep link on an unpaired phone
 * mounts a detail route without the tabs layout ever focusing, and a gate living only on the
 * tabs would leave that reader on an empty world with no way out. Connection-flow routes
 * (welcome, servers, scan, connect) stay ungated on purpose: they are where the verdicts route
 * to — including the wall's way off itself.
 */
import { Redirect } from "expo-router";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { useConnection } from "../net/connection";
import { accessLock, onAccessLock } from "../net/access-lock";
import { readAccess } from "../net/account";
import type { ConnectedSession } from "../net/pairing";
import "../state/access-verdict-native";
import { recordVerdict, storedVerdict, verdictsReady, verdictsSettled } from "../state/access-verdict";
import { gateFor } from "../state/gate";
import { useTheme } from "../theme";
import { AccountWall } from "./AccountWall";
import { Panel, Screen } from "./base";
import { awaitFirstPaint, paintsAtOnce, type FirstPaintInputs } from "./first-paint";
import { Wordmark } from "./Icon";
import { LifecycleStrip } from "./LifecycleStrip";
import { BootShell } from "./Skeleton";

/** The 402 sink's slot, subscribed — the transport writes it from outside React. */
function useAccessLock(): ReturnType<typeof accessLock> {
  return useSyncExternalStore(onAccessLock, accessLock, accessLock);
}

/** Sessions whose first paint is decided — shared by the two `Gated` mounts, so a pushed route asks nothing again. */
const firstPainted = new WeakSet<ConnectedSession>();

function firstPaintInputs(session: ConnectedSession): FirstPaintInputs {
  return {
    refusable: !session.standalone && session.profile.flavor === "managed",
    ready: verdictsReady,
    settled: verdictsSettled,
    stored: () => storedVerdict(session.profile.id),
    ask: () => readAccess(session),
  };
}

/**
 * `true` once this session's mail may paint — at once, or after the bounded verdict read. Bound,
 * accepted as the web's is: a stored `open` paints the mirror at once, so an account that closed
 * since the last check meets its wall with the first 402, one drain later.
 */
function useFirstPaint(session: ConnectedSession | null): boolean {
  const atOnce = session === null || firstPainted.has(session) || paintsAtOnce(firstPaintInputs(session));
  const [openFor, setOpenFor] = useState<ConnectedSession | null>(null);
  useEffect(() => {
    if (session === null || firstPainted.has(session) || paintsAtOnce(firstPaintInputs(session))) return;
    return awaitFirstPaint(firstPaintInputs(session), () => {
      firstPainted.add(session);
      setOpenFor(session);
    });
  }, [session]);
  return atOnce || openFor === session;
}

/** The frame the first paint waits behind: the mark and a spinner, no sentence and no mail. */
function AccessGate() {
  const t = useTheme();
  return (
    <Screen style={{ justifyContent: "center" }}>
      {/* A margin, not padding: `Screen` owns its horizontal padding (the safe-area insets). */}
      <Panel style={{ marginHorizontal: 24, padding: 24, gap: 18 }}>
        <Wordmark color={t.c.ink} dot={t.c.accent} size={22} />
        <View accessibilityRole="progressbar" style={{ alignItems: "flex-start" }}>
          <ActivityIndicator size="small" color={t.c.accent} />
        </View>
      </Panel>
    </Screen>
  );
}

export function Gated({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const lock = useAccessLock();
  const verdict = gateFor(conn.state, conn.profiles.length, lock);
  const session = conn.state.k === "live" ? conn.state.session : null;
  const painted = useFirstPaint(session);

  /* A wall the sink raised is this pairing's verdict for the next launch's first paint too. */
  useEffect(() => {
    if (lock !== null && session !== null && !session.standalone) recordVerdict(session.profile.id, "closed");
  }, [lock, session]);

  // NOT CONNECTED → the connect flow owns the screen; the mail UI renders only a live
  // mirror. `boot` and `connecting` both paint the instant shell (`BootShell`): the same
  // canvas + top bar the mail screens stand on, with the list silhouette arriving only
  // after the skeleton grace — so the keystore instant stays a quiet frame (a paired phone
  // never flashes the welcome screen on its way to mail), a LOCAL boot passes through in
  // milliseconds with no text screen, and nothing here ever waits on the network (the
  // connection layer goes live off the on-device mirror; sync runs behind the mail UI).
  if (verdict.to === "boot" || verdict.to === "connecting") return <BootShell />;
  if (verdict.to === "welcome") return <Redirect href="/welcome" />;
  if (verdict.to === "servers") return <Redirect href="/servers" />;
  /* AHEAD OF THE APP, the way the browser tab swaps its own surface: a person whose account the
     service has refused should not be reading mail behind it. It takes nothing away — the mirror
     on this phone is untouched and so is the mailbox. */
  if (verdict.to === "wall") return <AccountWall facts={verdict.facts} session={session} />;
  /* THE WALL BEFORE MAIL: no stored `open` for this pairing, so the verdict is asked first. */
  if (!painted) return <AccessGate />;
  /* THE STRIP ABOVE THE APP, in the one mount every gated screen shares: the deadline or the
     catch-up is a fact about the ACCOUNT, not about a pile, so it is drawn once rather than by
     each list. It renders nothing at all whenever there is nothing to say. */
  return (
    <>
      <LifecycleStrip session={session} />
      {children}
    </>
  );
}
