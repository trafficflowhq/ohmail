/**
 * WHERE THE OHBOX'S MAIL WENT — the line under the Ohbox's meta (row OHBOX-QUIET-READS-AS-STALLED):
 * when the mailboxes were last checked and how many letters went to which pile since the person was
 * here, each count a link to its pile; nothing while the top line has a sentence
 * (`live.ts#ohboxWhereSaid`). The web's `OhboxWhereLine`, in this app's own primitives.
 */
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useNetworkNow } from "../net/network-door";
import { useWorld } from "../state/world";
import { FILED_PILE_ROUTE, checkedAgoSaid, filedPileSaid, ohboxWhereSaid, type FiledSince } from "../state/live";
import { Tap, Txt } from "./base";

/** The relative "Checked" time moves by the minute. */
const TICK_MS = 60_000;

export function OhboxWhere({ filed }: { filed: FiledSince | null }) {
  const w = useWorld();
  const network = useNetworkNow();
  const [, setTick] = useState(0);
  /* Its own clock, only while the app is in front; a return to the front re-reads at once. */
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const arm = (state: string | null | undefined): void => {
      if (id !== null) clearInterval(id);
      id = null;
      if (state !== "active") return;
      setTick((n) => n + 1);
      id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    };
    arm(AppState.currentState);
    const sub = AppState.addEventListener("change", arm);
    return () => {
      if (id !== null) clearInterval(id);
      sub.remove();
    };
  }, []);

  const nowMs = Date.now();
  const said = ohboxWhereSaid({
    settled: w.boot.settled,
    network,
    connection: w.boot.connection,
    stale: w.boot.staleAsOf,
    draining: w.boot.draining,
    mailboxes: w.mailboxes.known ? w.mailboxes.rows : null,
    mailboxesReadAt: w.mailboxes.readAt(),
    nowMs,
    filed,
  });
  if (said === null) return null;
  if (said.checked === null && said.piles.length === 0) return null;
  const checked = said.checked === null ? null : Copy.whereChecked(checkedAgoSaid(said.checked, nowMs));
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", marginTop: 4 }}>
      {checked !== null ? <Txt variant="meta" tone="ink3">{checked}</Txt> : null}
      {said.piles.length > 0 ? (
        <Txt variant="meta" tone="ink3">
          {`${checked !== null ? " · " : ""}${Copy.whereSince(checked === null)} `}
        </Txt>
      ) : null}
      {said.piles.map((p, i) => {
        const text = Copy.whereTo(p.count, filedPileSaid(p.pile));
        return (
          <View key={p.pile} style={{ flexDirection: "row" }}>
            {i > 0 ? <Txt variant="meta" tone="ink3">{", "}</Txt> : null}
            <Tap
              accessibilityRole="link"
              accessibilityLabel={text}
              onPress={() => router.navigate(FILED_PILE_ROUTE[p.pile])}
            >
              <Txt variant="meta" tone="ink2">{text}</Txt>
            </Tap>
          </View>
        );
      })}
    </View>
  );
}
