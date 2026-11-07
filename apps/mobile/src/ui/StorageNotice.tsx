/**
 * THE STORAGE CARD atop the Ohbox, near the cap, at it, or when the plan's own lower limit is below
 * what is stored. It decides nothing: the server says whether a card is due (`card`), and
 * `storage-notice.ts` says it. The bar, the numbers, what is expected, the fitted plan named with
 * its room, then the plain "Manage your plan at ohmail.app" (a sideload build: the Manage
 * subscription press) and Dismiss, which the server keeps per account (an older server: this run).
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme";
import { Button, Panel, Txt, useCardSides, useTopPad } from "./base";
import { StorageBar } from "./StorageBar";
import { storageCardOf } from "./storage-notice";
import {
  accessFeedFor, mintManageLink, onAccessFeed, setStorageChoice, storagePutAwayOf, type ManageLink,
} from "../net/account";
import type { ConnectedSession } from "../net/pairing";

export function StorageNotice({ session, ohbox = true }: {
  session: ConnectedSession | null;
  /** The card stands atop the Ohbox only. */
  ohbox?: boolean;
}) {
  const t = useTheme();
  const locale = useLocale();
  const profileId = session !== null && !session.standalone ? session.profile.id : null;
  const feedOf = useCallback(() => (profileId === null ? null : accessFeedFor(profileId)), [profileId]);
  const entry = useSyncExternalStore(onAccessFeed, feedOf, feedOf);
  const [hiding, setHiding] = useState(false);
  const [failed, setFailed] = useState<"dismiss" | Exclude<ManageLink["kind"], "url"> | null>(null);
  const [minting, setMinting] = useState(false);
  /* Drawn outside the Screen, so it pays the status bar, the side insets and the rail itself. */
  const top = useTopPad(8);
  const sides = useCardSides(16);

  const card = storageCardOf(entry, Copy, locale, undefined, profileId === null ? undefined : storagePutAwayOf(profileId));
  if (card === null || session === null || !ohbox || hiding) return null;

  const dismiss = (): void => {
    setFailed(null);
    setHiding(true);
    void setStorageChoice(session, { dismiss: card.level }).then((ok) => {
      setHiding(false);
      if (!ok) setFailed("dismiss");
    });
  };
  const leave = async (): Promise<void> => {
    if (minting) return;
    setFailed(null);
    setMinting(true);
    try {
      const link = await mintManageLink(session, locale);
      if (link.kind === "url") { void Linking.openURL(link.url).catch(() => undefined); return; }
      setFailed(link.kind);
    } finally {
      setMinting(false);
    }
  };

  return (
    <Panel style={{ ...sides, marginTop: top, padding: 14, gap: 8 }}>
      <View accessibilityRole="summary" style={{ gap: 8 }}>
        <Txt variant="settingsLabel">{card.head}</Txt>
        <StorageBar parts={[card.ratio]} scale={1} />
        {card.lines.map((line) => (
          <Txt key={line} variant="note" tone="ink2">{line}</Txt>
        ))}
        {card.fit !== null ? (
          <View style={{ paddingHorizontal: 10, paddingVertical: 8, backgroundColor: t.c.accentSoft, borderRadius: t.radius.item }}>
            <Txt variant="note" tone="accent">{card.fit}</Txt>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {card.manage === "press" ? (
          <Button label={Copy.storageManage} variant="solid" onPress={() => { void leave(); }} />
        ) : (
          <Txt variant="note" style={{ flex: 1 }}>{Copy.storageManageAt}</Txt>
        )}
        <Button label={Copy.storageDismiss} variant="quiet" onPress={dismiss} style={card.manage === "press" ? { marginLeft: "auto" } : undefined} />
      </View>
      {failed !== null ? (
        <Txt variant="note" tone="ink2" accessibilityRole="alert">
          {failed === "dismiss" ? Copy.storageDismissFailed : failed === "unverified" ? Copy.wallMintUnverified : Copy.wallMintFailed}
        </Txt>
      ) : null}
    </Panel>
  );
}
