/**
 * THE STORAGE NOTICE (near the cap, at it, text emptied), under the lifecycle strip on the main screen.
 * It decides nothing — `storage-notice.ts` answers whether it is due and what it offers; this renders
 * it, presses, and puts it away for the account on this phone. It reads the access feed the strip
 * already keeps fresh, so it asks nothing of its own.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { Button, Panel, Txt } from "./base";
import { storageNoticeCap, storageNoticeKey, storageNoticeOf, storageNoticeText } from "./storage-notice";
import { accessFeedFor, mintManageLink, onAccessFeed, type ManageLink } from "../net/account";
import {
  onStorageNotices, putAwayStorageNotice, storageNoticePutAway, storageNoticesHeld,
} from "../state/storage-notice";
import type { ConnectedSession } from "../net/pairing";

export function StorageNotice({ session }: { session: ConnectedSession | null }) {
  const locale = useLocale();
  const profileId = session !== null && !session.standalone ? session.profile.id : null;
  const feedOf = useCallback(() => (profileId === null ? null : accessFeedFor(profileId)), [profileId]);
  const entry = useSyncExternalStore(onAccessFeed, feedOf, feedOf);
  const owner = session?.ownerKey ?? null;
  useSyncExternalStore(onStorageNotices, storageNoticesHeld, storageNoticesHeld);
  const [minting, setMinting] = useState(false);
  const [refused, setRefused] = useState<Exclude<ManageLink["kind"], "url"> | null>(null);

  const notice = storageNoticeOf(entry, (level, cap) => storageNoticePutAway(storageNoticeKey(owner, level, cap)));
  if (notice === null || session === null) return null;

  const leave = async (): Promise<void> => {
    if (minting) return;
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

  return (
    <Panel style={{ marginHorizontal: 16, marginTop: 8, padding: 14, gap: 8 }}>
      <Txt variant="body" accessibilityRole="summary">
        {storageNoticeText(notice, Copy, locale)}
      </Txt>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {notice.manage ? (
          <Button label={Copy.storageNoticeManage} variant="solid" onPress={() => { void leave(); }} />
        ) : null}
        <Button label={Copy.storageNoticeDismiss} variant="quiet" onPress={() => putAwayStorageNotice(storageNoticeKey(owner, notice.level, storageNoticeCap(notice.facts)))} />
      </View>
      {refused !== null ? (
        <Txt variant="note" tone="ink2" accessibilityRole="alert">
          {refused === "unverified" ? Copy.wallMintUnverified : Copy.wallMintFailed}
        </Txt>
      ) : null}
    </Panel>
  );
}
