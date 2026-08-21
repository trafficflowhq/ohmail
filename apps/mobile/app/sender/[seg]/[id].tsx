/**
 * One sender in the Screener: their actual mail, and the decision.
 *
 * TWO THINGS THIS SCREEN PROMISES.
 *
 *  1. **You never decide about a sender you cannot see.** Every held message
 *     renders here in full — subject, time, body, blocked trackers — and the
 *     caption states the count *and* that all of it is shown. There is no "and
 *     3 more"; a collapsed count is banned here. On a live account a held body starts
 *     as its snippet and hydrates; the caption under a truncation says so
 *     rather than presenting a preview as the mail.
 *  2. **"& read" means one thing at all five destinations.** Each capsule is
 *     split: the label files the mail, the attached ✓ files it *and* marks
 *     every held message seen first. Filing as read therefore does not move
 *     any unread count — it files mail, it does not announce it.
 *
 * The decision and the releases go through the world's actions — `engine.mutate`
 * with the optimistic overlay and the watched rollback (including the
 * rule-rewriting release family).
 *
 * Layout note: the decision bar is pinned to the bottom, because that is where
 * the thumb is and because the mail should be the thing under the eye.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../../../src/copy";
import { useTheme } from "../../../src/theme";
import {
  DESTINATIONS,
  destDone,
  destLabel,
  domainOf,
  type Destination,
  type Place,
  type ScreenerSeg,
} from "../../../src/state/model";
import { useWorld } from "../../../src/state/world";
import { Badge, Button, Panel, Screen, Scroller, Tap, Txt } from "../../../src/ui/base";
import { DetailBar } from "../../../src/ui/chrome";
import { Gated } from "../../../src/ui/Gated";
import { Icon } from "../../../src/ui/Icon";
import { Segmented } from "../../../src/ui/Segmented";

/** Gated like the tabs — a deep-linked or restored route must not render the empty world. */
export default function SenderScreen() {
  return (
    <Gated>
      <SenderBody />
    </Gated>
  );
}

function SenderBody() {
  const params = useLocalSearchParams<{ seg: string; id: string }>();
  const seg = (params.seg ?? "waiting") as ScreenerSeg;
  // `useLocalSearchParams` answers URI-DECODED values already — decoding again broke every
  // route key containing `%` (an address like foo%2Fbar@example.com decoded twice) and
  // could throw outright on a bare `%`. The push side still encodes; the hook decodes once.
  const id = params.id ?? "";
  const t = useTheme();
  const w = useWorld();

  const rows =
    seg === "waiting" ? w.screener.waiting : seg === "screened" ? w.screener.screened : w.screener.spam;
  // By the STABLE routeKey, never the representative message id: a live row is re-minted on
  // the sender's newest mail, so a drain landing while this screen is open would otherwise
  // make the lookup fail and the screen claim the sender left the Screener.
  const row = rows.find((x) => x.routeKey === id);

  // The decision is over the sender's ACTUAL mail: fetch every held body when the screen
  // opens. `actions` is identity-stable, and the held list is keyed by its ids so a
  // re-minted row re-asks only when the bag changed — plus the worldKey, so a route
  // restored before the session went live re-asks against the engine once it exists.
  const heldKey = row ? row.held.map((h) => h.id).join(",") : "";
  const hydrateHeld = w.actions.hydrateHeld;
  const worldKey = w.worldKey;
  useEffect(() => {
    if (heldKey) hydrateHeld(heldKey.split(","));
  }, [heldKey, hydrateHeld, worldKey]);

  if (!row) {
    return (
      <Screen>
        <DetailBar title={Copy.screener} />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            That sender is no longer in the Screener.
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const target = row.scope === "domain" ? `@${domainOf(row.address)}` : row.address;

  return (
    <Screen>
      <DetailBar title={Copy.screener} />
      <Scroller contentStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingHorizontal: 12, paddingBottom: 14 }}>
          <Txt variant="h2">{row.name}</Txt>
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
            {row.address}
          </Txt>
          {seg === "waiting" ? (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12, alignItems: "flex-start" }}>
              <View style={{ marginTop: 2 }}>
                <Icon name="spark" size={13} color={t.c.accentInk} />
              </View>
              <Txt variant="note" tone="ink2" style={{ flex: 1 }}>
                First contact. Nothing from this sender has reached the Ohbox — it waited here.
                {row.ai ? (
                  <>
                    {" "}
                    <Txt variant="settingsLabel">{destDone(row.ai.dest)}</Txt> is the AI's suggestion at{" "}
                    {row.ai.confidence.toFixed(2)}: {row.ai.rationale}.
                  </>
                ) : null}
              </Txt>
            </View>
          ) : null}
          {seg === "screened" ? (
            <Txt variant="note" tone="ink2" style={{ marginTop: 12 }}>
              {Copy.screenedNote(row.screenedOn, row.held.length)}
            </Txt>
          ) : null}
          {seg === "spam" ? (
            <View style={{ gap: 8, marginTop: 12 }}>
              {row.detection ? (
                <View style={{ flexDirection: "row" }}>
                  <Badge icon="shield">{row.detection}</Badge>
                </View>
              ) : null}
              <Txt variant="note" tone="ink2">
                {Copy.spamNote}
              </Txt>
            </View>
          ) : null}
        </View>

        <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          <Txt variant="caption" tone="ink3">
            {Copy.heldCaption(row.held.length, row.held[0]?.time)}
          </Txt>
        </View>

        {row.held.map((h) => (
          <Panel key={h.id} level="l1" radius={t.radius.card} style={{ marginBottom: 12, padding: 18 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
              <Txt variant="heldTitle" style={{ flexShrink: 1 }}>
                {h.subject}
              </Txt>
              <View style={{ flex: 1 }} />
              <Txt variant="caption" tone="ink3" tabular>
                {h.time}
              </Txt>
            </View>
            {h.trackerNote ? (
              <View style={{ flexDirection: "row", marginTop: 10 }}>
                <Badge icon="shield" tone="accent">
                  {h.trackerNote}
                </Badge>
              </View>
            ) : null}
            {/* A consent decision may not be taken over a truncation presented as the mail:
                while a live body is still its snippet, the panel says so under the text. */}
            {h.bodyState === "snippet" || h.bodyState === "loading" ? (
              <Txt variant="caption" tone="ink3" style={{ marginTop: 12 }}>
                {Copy.liveBodyLoading}
              </Txt>
            ) : h.bodyState === "withheld" ? (
              /* The cap's terminal state belongs here more than anywhere: the comment above is
                 about not taking a consent decision over a truncation presented as the mail,
                 and a withheld body is permanently exactly that. */
              <Txt variant="caption" tone="ink3" style={{ marginTop: 12 }}>
                {Copy.liveBodyWithheld}
              </Txt>
            ) : h.bodyState === "failed" ? (
              <Txt variant="caption" tone="ink3" style={{ marginTop: 12 }}>
                {Copy.liveBodyFailed}
              </Txt>
            ) : null}
            <Txt variant="streamBody" tone="ink" style={{ marginTop: 12 }}>
              {h.body}
            </Txt>
          </Panel>
        ))}
      </Scroller>

      {seg === "waiting" ? (
        <DecisionBar
          scope={row.scope}
          target={target}
          suggested={row.ai?.dest ?? null}
          onScope={(scope) => w.actions.setScope(row, scope)}
          onDecide={(dest, read) => {
            w.actions.decide(row, dest, read);
            router.back();
          }}
        />
      ) : null}

      {seg !== "waiting" ? (
        <ReleaseBar
          label={seg === "screened" ? Copy.allowLabel : Copy.notSpamLabel}
          onRelease={(dest) => {
            if (seg === "screened") w.actions.allow(row, dest);
            else w.actions.notSpam(row, dest);
            router.back();
          }}
        />
      ) : null}
    </Screen>
  );
}

/* ---------------------------------------------------------- decision bar */

function DecisionBar({
  scope,
  target,
  suggested,
  onScope,
  onDecide,
}: {
  scope: "sender" | "domain";
  target: string;
  suggested: Destination | null;
  onScope: (s: "sender" | "domain") => void;
  onDecide: (dest: Destination, read: boolean) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        {
          // `float`, not `panel`: this is the floating layer, and in dark the
          // two are a whole step apart — on `panel` the bar merged into the mail
          // card behind it, where black-on-black shadow cannot separate them.
          backgroundColor: t.c.float,
          borderTopLeftRadius: t.radius.panel,
          borderTopRightRadius: t.radius.panel,
          paddingHorizontal: 14,
          paddingTop: 14,
          paddingBottom: 12 + insets.bottom,
        },
        // The occlusion edge, flipped. `shadow.barEdge` is authored as
        // `0 14px 22px -18px` for a bar that sits *above* the mail; this one
        // sits below it, so the same geometry runs upward. Colour and blur are
        // the token's own — only the sign of the offset changes.
        t.liftUp("l3"),
        t.liftUp("barEdge"),
      ]}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {DESTINATIONS.map((dest) => (
          <DecisionCapsule
            key={dest}
            dest={dest}
            ai={dest === suggested}
            quiet={dest === "screened" || dest === "spam"}
            onFile={() => onDecide(dest, false)}
            onFileRead={() => onDecide(dest, true)}
          />
        ))}
      </View>

      <Segmented
        fill={false}
        style={{ marginTop: 12 }}
        value={scope}
        onChange={onScope}
        segments={[
          { value: "sender", label: Copy.scopeSender },
          { value: "domain", label: Copy.scopeDomain },
        ]}
      />

      <Txt variant="caption" tone="ink3" style={{ marginTop: 10, lineHeight: 16 }}>
        {Copy.decideRule(target)}
      </Txt>
    </View>
  );
}

/**
 * One destination. Split capsule: the label files, the ✓ files and marks read.
 * The AI's suggestion carries the accent ring — a preselect, never a default
 * that acts on its own.
 */
function DecisionCapsule({
  dest,
  ai,
  quiet,
  onFile,
  onFileRead,
}: {
  dest: Destination;
  ai: boolean;
  quiet: boolean;
  onFile: () => void;
  onFileRead: () => void;
}) {
  const t = useTheme();
  const [pressed, setPressed] = useState<"none" | "main" | "read">("none");
  return (
    <View
      style={[
        {
          flexDirection: "row",
          borderRadius: t.radius.pill,
          backgroundColor: t.c.float,
          overflow: "hidden",
          minHeight: 44,
        },
        t.lift("l0"),
        // `.dbtn.ai{box-shadow: 0 0 0 1.5px var(--accent-hair), var(--lift-0)}`
        // — the ring is added to the lift, not swapped for it, so the AI's
        // suggestion is marked out without being lifted off the row.
        ai ? { boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1.5, color: t.c.accentHair }] } : null,
      ]}
    >
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`${destDone(dest)}${ai ? ", suggested" : ""}`}
        onPress={onFile}
        onPressIn={() => setPressed("main")}
        onPressOut={() => setPressed("none")}
        style={{
          paddingHorizontal: 14,
          justifyContent: "center",
          minHeight: 44,
          backgroundColor: ai ? t.c.accentSoft : pressed === "main" ? t.c.tint : "transparent",
        }}
      >
        <Txt
          variant={ai ? "pileTitle" : "decision"}
          tone={ai ? "accent" : quiet ? "ink2" : "ink"}
          style={ai ? { fontSize: 12 } : undefined}
        >
          {destLabel(dest)}
        </Txt>
      </Tap>
      <View style={{ width: 1, backgroundColor: t.c.hairSoft }} />
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`${destDone(dest)}, and mark read`}
        onPress={onFileRead}
        onPressIn={() => setPressed("read")}
        onPressOut={() => setPressed("none")}
        style={{
          width: 44,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          backgroundColor: pressed === "read" ? t.c.accentSoft : "transparent",
        }}
      >
        <Icon name="check" size={13} color={pressed === "read" ? t.c.accentInk : t.c.ink3} weight={1.6} />
      </Tap>
    </View>
  );
}

/** Screened-out and spam release their whole held bag — never a subset. */
function ReleaseBar({ label, onRelease }: { label: string; onRelease: (dest: Place) => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const places: Place[] = ["ohbox", "reads", "receipts"];
  return (
    <View
      style={[
        {
          // `float`, not `panel`: this is the floating layer, and in dark the
          // two are a whole step apart — on `panel` the bar merged into the mail
          // card behind it, where black-on-black shadow cannot separate them.
          backgroundColor: t.c.float,
          borderTopLeftRadius: t.radius.panel,
          borderTopRightRadius: t.radius.panel,
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 12 + insets.bottom,
        },
        t.lift("l3"),
      ]}
    >
      <Txt variant="caption" tone="ink3">
        {label}
      </Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {places.map((p) => (
          <Button key={p} label={destLabel(p)} onPress={() => onRelease(p)} />
        ))}
      </View>
    </View>
  );
}
