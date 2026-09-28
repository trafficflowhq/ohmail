/**
 * THE STRIP ABOVE THE LIST — a deadline running out, or the catch-up after a reopening.
 *
 * Never a sheet: the app keeps working in every state this draws, and taking the screen would be
 * a lie about what has happened. It decides nothing — `lifecycle-strip.ts` answers which notice
 * there is and whether it was put away; this renders it and presses.
 *
 * The catch-up names no mailbox: a mailbox the closure paused resumes on its own (mail 0135), and
 * one the person stopped, or another install took, says so in Settings.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme";
import { appLifecycle } from "./AccountWall";
import { Button, Panel, Txt, useTopPad } from "./base";
import { dayStamp } from "./day-stamp";
import {
  QUIET_RETURN_MS, dismissKey, remember, settlesTheStrip, stripNotice,
} from "./lifecycle-strip";
import { RETURN_DEBOUNCE_MS, wallLift, type WallLift } from "./wall-lift";
import {
  accessFeedFor, mintManageLink, onAccessFeed, putAwayCatchUp, readAccess, type ManageLink,
} from "../net/account";
import { linksOutToBilling } from "../distribution";
import type { ConnectedSession } from "../net/pairing";

export function LifecycleStrip({ session }: { session: ConnectedSession | null }) {
  const locale = useLocale();
  const t = useTheme();
  /* IT FOLLOWS THE ACCOUNT: drawn from the access feed (`net/account.ts`), so the first-paint
     gate's answer, the wall's lift read and its own reads all move it, and it asks once on every
     return to the foreground (the wall's schedule with no clock). The standalone door has no
     plane and asks nothing. */
  const profileId = session !== null && !session.standalone ? session.profile.id : null;
  const feedOf = useCallback(() => (profileId === null ? null : accessFeedFor(profileId)), [profileId]);
  const entry = useSyncExternalStore(onAccessFeed, feedOf, feedOf);
  const [minting, setMinting] = useState(false);
  const [refused, setRefused] = useState<Exclude<ManageLink["kind"], "url"> | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const lift = useRef<WallLift | null>(null);
  const drawn = useRef(false);
  /* IT IS THE FIRST THING UNDER THE STATUS BAR whenever it draws — the shell mounts it above the
     screen, outside the chrome that pays this everywhere else. Measured on a device with a fixed
     8: the first line sat against the clock and the panel's top corners were cut off. */
  const top = useTopPad(8);

  const notice = stripNotice(entry, session?.ownerKey ?? null, hidden, Date.now());
  useEffect(() => { drawn.current = notice !== null; });
  /* Does the service operate an account page — `manageUrl` is that fact and nothing more; the
     press mints its own link. Absent on a deployment with no subscription page, and the press is
     then not drawn — a button that goes nowhere is worse than no button. */
  const offersPage = entry !== null && entry.answer.metered && entry.answer.manageUrl !== undefined;

  useEffect(() => {
    if (session === null || session.standalone) return;
    // The first paint: the gate's or the wall's answer is already here, or this asks once.
    if (accessFeedFor(session.profile.id) === null) void readAccess(session);
    const machine = wallLift({
      opens: async () => {
        const a = await readAccess(session);
        return a !== null && settlesTheStrip(a, Date.now());
      },
      lifecycle: appLifecycle,
      onCheck: () => undefined,
      minute: null,
      returnFloor: () => (drawn.current ? RETURN_DEBOUNCE_MS : QUIET_RETURN_MS),
      lastAsked: () => accessFeedFor(session.profile.id)?.at ?? Number.NEGATIVE_INFINITY,
    });
    lift.current = machine;
    return () => {
      machine.stop();
      if (lift.current === machine) lift.current = null;
    };
  }, [session]);

  const putAway = useCallback(() => {
    if (notice === null) return;
    const key = dismissKey(notice, session?.ownerKey ?? null);
    remember(key);
    if (notice.kind === "caughtUp" && profileId !== null) putAwayCatchUp(profileId);
    setHidden((was) => new Set([...was, key]));
  }, [notice, profileId, session]);

  /* MINTED AT THE PRESS, opened in the SYSTEM browser: a held link lives ten minutes and once.
     The return to the foreground then polls, as the wall's way back does. */
  const leave = async (): Promise<void> => {
    if (minting || session === null) return;
    setRefused(null);
    setMinting(true);
    try {
      const link = await mintManageLink(session, locale);
      if (link.kind === "url") {
        lift.current?.armPoll();
        void Linking.openURL(link.url).catch(() => undefined);
        return;
      }
      setRefused(link.kind);
    } finally {
      setMinting(false);
    }
  };

  if (notice === null) return null;

  if (notice.kind === "caughtUp") {
    return (
      <Panel style={{ marginHorizontal: 16, marginTop: top, padding: 14, gap: 8 }}>
        <Txt variant="body" accessibilityRole="summary">
          {Copy.stripCaughtUp(dayStamp(notice.since, locale))}
        </Txt>
        <Button label={Copy.stripDismiss} variant="quiet" onPress={putAway} />
      </Panel>
    );
  }

  const date = dayStamp(notice.deadline, locale);
  /* THE STORE FACE SAYS THE SAME SENTENCE AND OFFERS NO DOOR: the page the button would open is
     where a subscription is bought (App Review 3.1.1, Play's billing rule). The strip keeps its
     sentence, which is the part that matters — the deadline is a fact whatever the build is. */
  const mayLinkOut = linksOutToBilling();
  return (
    <Panel
      style={{
        marginHorizontal: 16,
        marginTop: top,
        padding: 14,
        gap: 8,
      }}
    >
      <Txt variant="body" accessibilityRole="summary">
        {notice.kind === "grace"
          ? Copy.stripGraceEnds(date)
          : notice.kind === "pastDue"
            ? Copy.stripPaymentFailed(date)
            : Copy.stripTrialEnds(date)}
      </Txt>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {mayLinkOut && offersPage ? (
          <View>
            <Button
              label={notice.kind === "pastDue" ? Copy.stripFixPayment : Copy.stripSubscribe}
              variant="solid"
              onPress={() => { void leave(); }}
            />
            {/* MINTING: the wall's face — the same label with a spinner on it. */}
            {minting ? (
              <ActivityIndicator
                size="small"
                color={t.c.onAccent}
                style={{ position: "absolute", right: 16, top: 0, bottom: 0 }}
              />
            ) : null}
          </View>
        ) : null}
        {/* The way out is always there. A strip somebody cannot put away has to be right about
            how often it appears; this one is right about that AND can be put away. */}
        <Button label={Copy.stripLater} variant="quiet" onPress={putAway} />
      </View>
      {refused !== null ? (
        <Txt variant="note" tone="ink2" accessibilityRole="alert">
          {refused === "unverified" ? Copy.wallMintUnverified : Copy.wallMintFailed}
        </Txt>
      ) : null}
    </Panel>
  );
}
