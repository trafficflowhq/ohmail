/**
 * THE GATE, RENDERED — the one component that turns `gateFor`'s verdict into a surface.
 *
 * Both mail groups wrap themselves in this: the tabs layout AND the pushed mail detail
 * routes (`app/(mail)/_layout.tsx`). The second wrap exists because a deep link —
 * `ohmail://message/<id>` on an unpaired phone, a route restored after the session ended —
 * mounts a detail route WITHOUT the tabs layout ever focusing, and a gate that lives only
 * on the tabs would leave that reader on an empty world with no way out. Connection-flow
 * routes (welcome, servers, scan, connect) stay ungated on purpose: they are where the
 * verdicts route TO.
 */
import { Redirect } from "expo-router";
import { View } from "react-native";
import type { ReactNode } from "react";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import { gateFor } from "../state/gate";
import { Screen, Txt } from "./base";

export function Gated({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const verdict = gateFor(conn.state, conn.profiles.length);

  // NOT CONNECTED → the connect flow owns the screen; the mail UI renders only a live
  // mirror. `boot` paints nothing for the instant before the keystore answers, so a
  // paired phone never flashes the welcome screen on its way to mail.
  if (verdict.to === "boot") return <Screen>{null}</Screen>;
  if (verdict.to === "welcome") return <Redirect href="/welcome" />;
  if (verdict.to === "servers") return <Redirect href="/servers" />;
  if (verdict.to === "connecting") return <ConnectingView origin={verdict.origin} />;
  return <>{children}</>;
}

/** A boot or switch in flight — one sentence, not the mail UI and not a spinner circus. */
function ConnectingView({ origin }: { origin: string }) {
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 8 }}>
        <Txt variant="settingsLabel">{origin}</Txt>
        <Txt variant="caption" tone="ink3">
          {Copy.connectBooting}
        </Txt>
      </View>
    </Screen>
  );
}
