/**
 * THE SENT-MAIL SEED OFFER, above the lists — "you've written to these people" with Review them
 * and Not now — and its Settings row. When it is owed and what it holds is `state/seed-offer.ts`'s;
 * the review itself is the `/seed-review` route. A read that could not be made draws nothing.
 */
import { router } from "expo-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import { readSeedReview } from "../net/consent";
import {
  advanceSeedOffer, bindSeedOfferKV, profileQuestionOpenNow, seedLater, seedOfferOf, seedOfferVersion,
  seedReopenable, subscribeSeedOffer, type SeedFacts, type SeedOffer,
} from "../state/seed-offer";
import { secureKV } from "../state/servers-native";
import { useWorld } from "../state/world";
import { Button, Panel, Txt, useTopPad } from "./base";

/* "Not now" is kept in the keystore, bound once like the access verdicts. */
bindSeedOfferKV(secureKV());

/** The offer for the live session, and the work it still needs started. */
export function useSeedOffer(): { offer: SeedOffer; owner: string | null; facts: SeedFacts } {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  useSyncExternalStore(subscribeSeedOffer, seedOfferVersion, seedOfferVersion);
  const profileQuestionOpen = profileQuestionOpenNow();
  const facts = useMemo<SeedFacts>(
    () => ({ seed: w.seed, mailboxes: { known: w.mailboxes.known, rows: w.mailboxes.rows }, profileQuestionOpen }),
    [w.seed, w.mailboxes.known, w.mailboxes.rows, profileQuestionOpen],
  );
  const owner = session?.ownerKey ?? null;
  useEffect(() => {
    if (session === null) return;
    void advanceSeedOffer(session.ownerKey, facts, () => readSeedReview(session));
  }, [session, facts]);
  return { offer: owner === null ? { kind: "waiting" } : seedOfferOf(owner, facts), owner, facts };
}

export function SeedOfferCard() {
  const top = useTopPad(8);
  const { offer, owner } = useSeedOffer();
  if (offer.kind !== "offer" || owner === null) return null;
  return (
    <Panel style={{ marginHorizontal: 16, marginTop: top, padding: 14, gap: 8 }}>
      <Txt variant="body" accessibilityRole="summary">{Copy.seedTitle(offer.review.candidates.length)}</Txt>
      <Txt variant="note" tone="ink2">{Copy.seedLede}</Txt>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button label={Copy.seedReopenAction} variant="solid" onPress={() => router.push("/seed-review")} />
        <Button label={Copy.seedLater} variant="quiet" onPress={() => { void seedLater(owner); }} />
      </View>
    </Panel>
  );
}

/** SETTINGS: look at the people written to again, wherever this door organizes a mailbox. */
export function SeedReopenPanel() {
  const { facts } = useSeedOffer();
  if (!seedReopenable(facts)) return null;
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.seedSettingsLabel}</Txt>
        <Txt variant="note" tone="ink2">{Copy.seedReopenBody}</Txt>
        <View style={{ flexDirection: "row", marginTop: 4 }}>
          <Button
            label={Copy.seedReopenAction}
            variant="quiet"
            onPress={() => router.push({ pathname: "/seed-review", params: { from: "settings" } })}
          />
        </View>
      </View>
    </Panel>
  );
}
