/**
 * THE SENT-MAIL REVIEW — the people this account has written to, shown before anything acts. The
 * web's `SeedReviewView` on the phone: the decisions are `src/ui/seed-review.ts`'s, the offer that
 * opens it `src/state/seed-offer.ts`'s. Confirming writes rules and moves nothing itself: the
 * engine releases what the Screener holds from the ticked people, and the drain after the press
 * brings the rules in. Opened from Settings (`?from=settings`) it says when nobody is waiting.
 */
import * as Crypto from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, View } from "react-native";
import { Copy } from "../src/copy";
import { useLocale } from "../src/i18n/LocaleProvider";
import { useConnection } from "../src/net/connection";
import { readSeedReview, type SeedCandidate } from "../src/net/consent";
import { seedAnswered, seedHandBack, seedLater, seedReviewHeld } from "../src/state/seed-offer";
import { Button, Panel, Screen, Tap, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Field } from "../src/ui/Field";
import { Gated } from "../src/ui/Gated";
import { Icon } from "../src/ui/Icon";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import {
  actionableOf, bulkOffered, confirmFailureSaid, excludedSaid, initialTicks, nothingToDecide, pressConfirm, setShown,
  shownOf, toggled, type ReviewPhase,
} from "../src/ui/seed-review";
import { useTheme } from "../src/theme";

export default function SeedReviewScreen() {
  useLocale();
  return (
    <SurfaceBoundary surface="seed">
      <Gated>
        <SeedReviewBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function SeedReviewBody() {
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  const fromSettings = useLocalSearchParams<{ from?: string }>().from === "settings";
  const [phase, setPhase] = useState<ReviewPhase>({ state: "loading" });
  const [ticks, setTicks] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const owner = session?.ownerKey ?? null;

  useEffect(() => {
    if (session === null) return;
    let live = true;
    const held = fromSettings ? null : seedReviewHeld(session.ownerKey);
    void (held !== null ? Promise.resolve(held) : readSeedReview(session)).then((review) => {
      if (!live) return;
      if (review === null) { setPhase({ state: "unavailable" }); return; }
      setPhase({ state: "ready", review });
      setTicks(initialTicks(review));
    });
    return () => { live = false; };
  }, [session, fromSettings]);

  const review = phase.state === "ready" || phase.state === "confirming" ? phase.review : null;
  const nothing = phase.state === "ready" && nothingToDecide(phase.review);
  /* Offered with nobody to decide about: hand the stage back, this launch only. */
  const handed = useRef(false);
  useEffect(() => {
    if (!nothing || fromSettings || owner === null || handed.current) return;
    handed.current = true;
    seedHandBack(owner);
    router.back();
  }, [nothing, fromSettings, owner]);

  const shown = useMemo(() => (review === null ? [] : shownOf(review, filter)), [review, filter]);
  const actionable = useMemo(() => actionableOf(shown), [shown]);
  const shownTicked = actionable.filter((c) => ticks.has(c.address)).length;

  const later = useCallback(() => {
    if (!fromSettings && owner !== null) void seedLater(owner);
    router.back();
  }, [fromSettings, owner]);

  const confirm = useCallback(() => {
    if (session === null || review === null) return;
    setPhase({ state: "confirming", review });
    void pressConfirm(session, review, ticks, Crypto.randomUUID()).then((next) => {
      if (next !== null) { setPhase(next); return; }
      seedAnswered(session.ownerKey);
      /* The release runs on the engine's pass this pull starts; the drain brings the rules in. */
      void conn.syncNow();
      router.back();
    });
  }, [session, review, ticks, conn]);

  if (phase.state === "loading") {
    return (
      <Screen>
        <DetailBar />
        <Txt variant="note" tone="ink2" style={{ padding: 20 }}>{Copy.seedLoading}</Txt>
      </Screen>
    );
  }
  if (phase.state === "unavailable" || (nothing && fromSettings)) {
    return (
      <Screen>
        <DetailBar />
        <View style={{ padding: 20, gap: 10 }}>
          {phase.state === "unavailable" ? <Txt variant="body">{Copy.seedErrorTitle}</Txt> : null}
          <Txt variant="note" tone="ink2">
            {phase.state === "unavailable" ? Copy.seedErrorGeneric : Copy.seedNothingToDecide}
          </Txt>
          <Button
            label={phase.state === "unavailable" ? Copy.seedLater : Copy.seedClose}
            variant="quiet"
            onPress={phase.state === "unavailable" ? later : () => router.back()}
          />
        </View>
      </Screen>
    );
  }
  if (review === null || nothing) return null;
  const busy = phase.state === "confirming";
  const failure = phase.state === "ready" && "error" in phase ? confirmFailureSaid(phase.error) : null;

  const head = (
    <View style={{ gap: 10, paddingBottom: 8 }}>
      <Txt variant="h1">{Copy.seedTitle(review.candidates.length)}</Txt>
      <Txt variant="note" tone="ink2">{Copy.seedLede}</Txt>
      {review.truncated ? <Txt variant="note" tone="ink2">{Copy.seedTruncated(review.scannedMessages)}</Txt> : null}
      {failure !== null ? <Txt variant="note" tone="ink2" accessibilityRole="alert">{failure}</Txt> : null}
      <Field value={filter} onChange={setFilter} label={Copy.seedFilterPlaceholder} input={{ autoCapitalize: "none", autoCorrect: false }} />
      {bulkOffered(review) ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button
            label={Copy.seedSelectShown(actionable.length)}
            variant="quiet"
            disabled={busy || actionable.length === 0 || shownTicked === actionable.length}
            onPress={() => setTicks((t) => setShown(t, actionable, true))}
          />
          <Button
            label={Copy.seedDeselectShown(shownTicked)}
            variant="quiet"
            disabled={busy || shownTicked === 0}
            onPress={() => setTicks((t) => setShown(t, actionable, false))}
          />
        </View>
      ) : null}
    </View>
  );

  const foot = (
    <View style={{ gap: 10, paddingTop: 12 }}>
      {review.excluded.length > 0 ? (
        <Panel style={{ padding: 14, gap: 6 }}>
          <Tap accessibilityRole="button" accessibilityState={{ expanded: showExcluded }} onPress={() => setShowExcluded((s) => !s)}>
            <Txt variant="note" tone="ink2">{Copy.seedExcludedSummary(review.excluded.length)}</Txt>
          </Tap>
          {showExcluded ? review.excluded.map((e) => (
            <View key={e.address}>
              <Txt variant="caption" tone="ink2">{e.address}</Txt>
              <Txt variant="caption" tone="ink3">{excludedSaid(e.reason)}</Txt>
            </View>
          )) : null}
        </Panel>
      ) : null}
      <Txt variant="note" tone="ink2">{Copy.seedWillDo(ticks.size)}</Txt>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button label={busy ? Copy.seedConfirming : Copy.seedConfirm(ticks.size)} variant="solid" disabled={busy} onPress={confirm} />
        <Button label={Copy.seedLater} variant="quiet" disabled={busy} onPress={later} />
      </View>
    </View>
  );

  return (
    <Screen>
      <DetailBar />
      <FlatList
        data={shown}
        keyExtractor={(c) => c.address}
        ListHeaderComponent={head}
        ListFooterComponent={foot}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <SeedRow c={item} ticked={ticks.has(item.address)} locked={item.alreadyDecided || busy}
            onPress={() => setTicks((t) => toggled(t, item.address))} />
        )}
      />
    </Screen>
  );
}

function SeedRow({ c, ticked, locked, onPress }: { c: SeedCandidate; ticked: boolean; locked: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Tap
      accessibilityRole="checkbox"
      accessibilityState={{ checked: ticked, disabled: locked }}
      disabled={locked}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}
    >
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: t.c.ink3, alignItems: "center", justifyContent: "center" }}>
        {ticked ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Txt variant="body">{c.name ?? c.address}</Txt>
        {c.name !== null ? <Txt variant="caption" tone="ink3">{c.address}</Txt> : null}
        <Txt variant="caption" tone="ink3">{Copy.seedWrote(c.messages)}</Txt>
        {c.alreadyDecided ? <Txt variant="caption" tone="ink3">{Copy.seedAlreadyDecided}</Txt> : null}
      </View>
    </Tap>
  );
}
