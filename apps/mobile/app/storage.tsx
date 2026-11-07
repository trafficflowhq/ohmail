/**
 * Settings → Storage: the numbers the card shows, in full. Used of the cap, per mailbox, what the
 * mail is expected to need in GB and in letters, from which month text is kept, what counts and why
 * it is limited, the plans with their rooms and the fitted one, and the storage mails switch. The
 * store face names no amount and links nowhere: "Manage your plan at ohmail.app" is plain text.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";
import { Copy } from "../src/copy";
import { useLocale } from "../src/i18n/LocaleProvider";
import {
  accessFeedFor, mintManageLink, onAccessFeed, readAccess, setStorageChoice, type ManageLink,
} from "../src/net/account";
import { useConnection } from "../src/net/connection";
import type { ConnectedSession } from "../src/net/pairing";
import { useWorld } from "../src/state/world";
import { Button, Panel, Screen, Scroller, Section, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";
import { StoragePane } from "../src/ui/StoragePane";

export default function StorageScreen() {
  useLocale();
  return (
    <SurfaceBoundary surface="storage">
      <Gated>
        <StorageBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function StorageBody() {
  const conn = useConnection();
  const w = useWorld();
  const session = conn.state.k === "live" ? conn.state.session : null;
  const profileId = session !== null && !session.standalone ? session.profile.id : null;
  const feedOf = useCallback(() => (profileId === null ? null : accessFeedFor(profileId)), [profileId]);
  const entry = useSyncExternalStore(onAccessFeed, feedOf, feedOf);
  /* The numbers are read fresh on arrival; the feed redraws this screen when they land. */
  useEffect(() => { if (session !== null) void readAccess(session); }, [session]);
  const facts = entry?.answer.metered ? entry.answer.storage : undefined;
  const label = (id: string): string => {
    const row = w.mailboxes.all.find((m) => m.id === id);
    return row?.displayName ?? row?.address ?? "";
  };

  return (
    <Screen>
      <DetailBar />
      <Scroller bounded>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.storageTitle}</Txt>
        </View>
        {facts === undefined || session === null ? (
          <Panel style={{ padding: 20 }}>
            <Txt variant="note" tone="ink2">{Copy.storageNone}</Txt>
          </Panel>
        ) : (
          <>
            <StoragePane facts={facts} labelOf={label} manage={<ManageRow session={session} />} />
            {facts.mail !== null ? <MailsPanel session={session} on={facts.mail} /> : null}
          </>
        )}
      </Scroller>
    </Screen>
  );
}

function ManageRow({ session }: { session: ConnectedSession }) {
  const locale = useLocale();
  const [minting, setMinting] = useState(false);
  const [refused, setRefused] = useState<Exclude<ManageLink["kind"], "url"> | null>(null);
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
    <View style={{ gap: 6 }}>
      <Button label={Copy.storageManage} variant="solid" onPress={() => { void leave(); }} style={{ alignSelf: "flex-start" }} />
      {refused !== null ? (
        <Txt variant="note" tone="ink2" accessibilityRole="alert">
          {refused === "unverified" ? Copy.wallMintUnverified : Copy.wallMintFailed}
        </Txt>
      ) : null}
    </View>
  );
}

function MailsPanel({ session, on }: { session: ConnectedSession; on: boolean }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const write = (next: "on" | "off"): void => {
    if (pending || (next === "on") === on) return;
    setFailed(false);
    setPending(true);
    void setStorageChoice(session, { mail: next === "on" }).then((ok) => {
      setPending(false);
      if (!ok) setFailed(true);
    });
  };
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <Section>{Copy.storageMails}</Section>
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        <Segmented<"on" | "off">
          value={on ? "on" : "off"}
          onChange={write}
          segments={[
            { value: "off", label: Copy.switchOff },
            { value: "on", label: Copy.switchOn },
          ]}
        />
        <Txt variant="caption" tone="ink3">{on ? Copy.storageMailsOn : Copy.storageMailsOff}</Txt>
        {failed ? <Txt variant="caption" tone="ink2">{Copy.storageMailsFailed}</Txt> : null}
      </View>
    </Panel>
  );
}
