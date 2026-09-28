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

import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { Button, Panel, Txt, useTopPad } from "./base";
import { dayStamp } from "./day-stamp";
import { dismissKey, dismissed, noticeOf, remember, type Notice } from "./lifecycle-strip";
import { mintManageLink, readAccess, type ManageLink } from "../net/account";
import { linksOutToBilling } from "../distribution";
import type { ConnectedSession } from "../net/pairing";

export function LifecycleStrip({ session }: { session: ConnectedSession | null }) {
  const locale = useLocale();
  const [notice, setNotice] = useState<Notice | null>(null);
  /* Does the service operate an account page — `manageUrl` is that fact and nothing more; the
     press mints its own link. Absent on a deployment with no subscription page, and the press is
     then not drawn — a button that goes nowhere is worse than no button. */
  const [offersPage, setOffersPage] = useState(false);
  const [minting, setMinting] = useState(false);
  const [refused, setRefused] = useState<Exclude<ManageLink["kind"], "url"> | null>(null);
  const [gone, setGone] = useState(false);
  /* IT IS THE FIRST THING UNDER THE STATUS BAR whenever it draws — the shell mounts it above the
     screen, outside the chrome that pays this everywhere else. Measured on a device with a fixed
     8: the first line sat against the clock and the panel's top corners were cut off. */
  const top = useTopPad(8);

  useEffect(() => {
    if (session === null || session.standalone) return;
    let live = true;
    void readAccess(session).then((a) => {
      /* A read that could not happen says NOTHING: a strip drawn from a failed request would
         appear and vanish with the network. `metered: false` is a self-hosted server, which has
         no lifecycle to report and never will. */
      if (!live || a === null || !a.metered) return;
      const next = noticeOf(a.lifecycle, a.caughtUp, Date.now());
      if (next === null || dismissed(dismissKey(next, session.ownerKey))) return;
      setNotice(next);
      setOffersPage(a.manageUrl !== undefined);
    });
    return () => { live = false; };
  }, [session]);

  const putAway = useCallback(() => {
    if (notice !== null) remember(dismissKey(notice, session?.ownerKey ?? null));
    setGone(true);
  }, [notice, session]);

  /* MINTED AT THE PRESS, opened in the SYSTEM browser: a held link lives ten minutes and once. */
  const leave = async (): Promise<void> => {
    if (minting || session === null) return;
    setRefused(null);
    setMinting(true);
    try {
      const link = await mintManageLink(session, locale);
      if (link.kind === "url") { void Linking.openURL(link.url).catch(() => undefined); return; }
      setRefused(link.kind);
    } finally {
      setMinting(false);
    }
  };

  if (notice === null || gone) return null;

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
          <Button
            label={notice.kind === "pastDue" ? Copy.stripFixPayment : Copy.stripSubscribe}
            variant="solid"
            onPress={() => { void leave(); }}
          />
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
