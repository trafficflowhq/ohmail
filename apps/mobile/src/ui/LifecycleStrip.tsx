/**
 * THE STRIP ABOVE THE LIST — a deadline running out, or the catch-up after a reopening.
 *
 * Never a sheet: the app keeps working in every state this draws, and taking the screen would be
 * a lie about what has happened. It decides nothing — `lifecycle-strip.ts` answers which notice
 * there is and whether it was put away; this renders it and presses.
 *
 * NO AUTO RE-CLAIM (DUAL-MODE §4): ohmail released every lease when the account closed, and the
 * press that resumes organizing is the Settings screen's own, reached by route with its ceremony.
 */

import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { Button, Panel, Txt, useTopPad } from "./base";
import { dayStamp } from "./day-stamp";
import { dismissKey, dismissed, noticeOf, remember, stoodDown, type Notice } from "./lifecycle-strip";
import { readAccess } from "../net/account";
import { linksOutToBilling } from "../distribution";
import { readMailboxes } from "../net/mailboxes";
import type { PhoneMailbox } from "../net/mailboxes";
import type { ConnectedSession } from "../net/pairing";

export function LifecycleStrip({ session }: { session: ConnectedSession | null }) {
  const locale = useLocale();
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [handedBack, setHandedBack] = useState<PhoneMailbox[]>([]);
  /* The door the strip's one press opens, as the SERVER gave it. Absent on a deployment with no
     subscription page, and the press is then not drawn — a button that goes nowhere is worse than
     no button. */
  const [manageUrl, setManageUrl] = useState<string | null>(null);
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
      setManageUrl(a.manageUrl ?? null);
      // Only the catch-up names mailboxes, so only it pays for the roster read.
      if (next.kind !== "caughtUp") return;
      void readMailboxes(session).then((rows) => {
        if (live && rows !== null) setHandedBack(stoodDown(rows));
      });
    });
    return () => { live = false; };
  }, [session]);

  const putAway = useCallback(() => {
    if (notice !== null) remember(dismissKey(notice, session?.ownerKey ?? null));
    setGone(true);
  }, [notice, session]);

  const leave = (url: string): void => {
    /* The SYSTEM browser, always — the page is the service's and the person is signed in there. */
    void Linking.openURL(url).catch(() => undefined);
  };

  if (notice === null || gone) return null;

  if (notice.kind === "caughtUp") {
    return (
      <Panel style={{ marginHorizontal: 16, marginTop: top, padding: 14, gap: 8 }}>
        <Txt variant="body" accessibilityRole="summary">
          {Copy.stripCaughtUp(notice.count, dayStamp(notice.since, locale))}
        </Txt>
        {handedBack.length > 0 ? (
          <>
            <Txt variant="note" tone="ink2">{Copy.stripHandedBack}</Txt>
            {handedBack.map((m) => (
              <View
                key={m.id}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}
              >
                <Txt variant="note" tone="ink2" style={{ flexShrink: 1 }}>
                  {m.displayName ?? m.address}
                </Txt>
                <Button
                  label={Copy.stripStartOrganizing}
                  variant="quiet"
                  onPress={() => router.push("/settings")}
                />
              </View>
            ))}
          </>
        ) : null}
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
        {mayLinkOut && manageUrl !== null ? (
          <Button
            label={notice.kind === "pastDue" ? Copy.stripFixPayment : Copy.stripSubscribe}
            variant="solid"
            onPress={() => leave(manageUrl)}
          />
        ) : null}
        {/* The way out is always there. A strip somebody cannot put away has to be right about
            how often it appears; this one is right about that AND can be put away. */}
        <Button label={Copy.stripLater} variant="quiet" onPress={putAway} />
      </View>
    </Panel>
  );
}
