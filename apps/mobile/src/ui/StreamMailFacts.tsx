import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { design } from "@ohmail/tokens/design";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { distinctDeliveryLabel } from "@ohmail/app-logic/reader/mailbox-label";
import { Copy } from "../copy";
import type { WorldMail } from "../state/live";
import { useWorld } from "../state/world";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { space } from "../theme/tokens";
import { Badge, Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { MailAvatar } from "./MailAvatar";
import { MailboxChip } from "./MailboxChip";
import { StreamMailMenu } from "./StreamMailMenu";

export const paperStreamCardStyle = { marginBottom: 12, marginHorizontal: mailSize.inset - space.deckCompact };

interface StreamHeadMail {
  from: WorldMail["from"];
  time: string;
  mailboxLabel?: string;
  recipients?: WorldMail["recipients"];
  imagesBlocked?: boolean;
  trackerNote?: string;
}

export function StreamCardHead({ m, onRead, receipt = false }: {
  m: StreamHeadMail;
  onRead: () => void;
  receipt?: boolean;
}) {
  const t = useTheme();
  const own = useWorld().mailboxes.ownAddresses;
  const [details, setDetails] = useState(false);
  const [shield, setShield] = useState(false);
  const recipients = m.recipients;
  const isOwn = (address: string) => own.some((a) => a.toLowerCase() === address.toLowerCase());
  const hasRecipients = recipients !== undefined && (
    recipients.to.length + recipients.cc.length > 1
    || recipients.to.some(({ address }) => isOwn(address))
    || recipients.cc.some(({ address }) => isOwn(address))
  );
  const hasShield = m.imagesBlocked || m.trackerNote;
  const delivery = receipt ? null : distinctDeliveryLabel(m.mailboxLabel, recipients, own);
  const names = (people: NonNullable<WorldMail["recipients"]>["to"]): string => people.map((p) =>
    isOwn(p.address) ? Copy.streamYouAt(displayAddress(p.address)) : p.name || displayAddress(p.address),
  ).join(", ");
  const addresses = (people: NonNullable<WorldMail["recipients"]>["to"]): string =>
    people.map((p) => displayAddress(p.address)).join(", ");
  const menu = <StreamMailMenu onRead={onRead} />;
  const time = <Txt variant="caption" tone="ink2" tabular style={{ marginLeft: "auto" }}>{m.time}</Txt>;

  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 24, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Tap accessibilityRole="button" onPress={onRead}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
          <MailAvatar person={m.from} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt variant="rowSender" numberOfLines={1}>{m.from.name}</Txt>
            {m.from.address !== m.from.name ? (
              <Txt variant="caption" tone="ink2" numberOfLines={1}>{displayAddress(m.from.address)}</Txt>
            ) : null}
          </View>
        </Tap>
        {receipt ? null : menu}
      </View>
      <View style={{ paddingLeft: mailSize.avatar + 12, gap: 4 }}>
        {receipt ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginLeft: "auto", gap: 8 }}>
            {menu}{time}
          </View>
        ) : null}
        {hasRecipients ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "baseline" }}>
              <Txt variant="caption" tone="ink2" numberOfLines={2} style={{ flexShrink: 1 }}>
                {recipients.to.length ? Copy.readerToLine(names(recipients.to)) : null}
                {recipients.to.length && recipients.cc.length ? " · " : null}
                {recipients.cc.length ? Copy.readerCcLine(names(recipients.cc)) : null}
              </Txt>
              <Tap accessibilityRole="button" accessibilityLabel={Copy.readerRecipientDetails}
                accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)}>
                <Txt variant="caption" tone="ink2" style={{ textDecorationLine: "underline" }}>
                  {" "}{Copy.readerDetailsShort}
                </Txt>
              </Tap>
            </View>
            {details ? (
              <>
                {recipients.to.length ? <Txt variant="caption" tone="ink2">{Copy.readerToLine(addresses(recipients.to))}</Txt> : null}
                {recipients.cc.length ? <Txt variant="caption" tone="ink2">{Copy.readerCcLine(addresses(recipients.cc))}</Txt> : null}
              </>
            ) : null}
          </>
        ) : null}
        {!receipt || hasShield ? <View style={{ flexDirection: "row", alignItems: "center", gap: mailSize.inset }}>
          {hasShield ? (
            <Tap accessibilityRole="button"
              accessibilityLabel={[m.imagesBlocked && Copy.mailImagesCaption, m.trackerNote && Copy.mailTrackerCaption].filter(Boolean).join(". ")}
              accessibilityState={{ expanded: shield }} onPress={() => setShield(!shield)}
              style={{ width: 32, height: 32, borderRadius: t.radius.pill, backgroundColor: t.c.tint2,
                alignItems: "center", justifyContent: "center" }}>
              <Icon name="shield" size={16} color={t.c.ink2} />
            </Tap>
          ) : null}
          {delivery ? <MailboxChip label={delivery} showDelivery /> : null}
          {receipt ? null : time}
        </View> : null}
        {shield ? <StreamContentChips images={m.imagesBlocked} tracker={m.trackerNote} /> : null}
      </View>
    </View>
  );
}

function StreamContentChips({ images, tracker }: { images?: boolean; tracker?: string }) {
  if (!images && !tracker) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {images ? <Badge icon="shield">{Copy.mailImagesCaption}</Badge> : null}
      {tracker ? <Badge icon="shield">{Copy.mailTrackerCaption}</Badge> : null}
    </View>
  );
}

export function StreamListTools({ settled, fresh, children }: {
  settled: boolean;
  fresh: number;
  children: ReactNode;
}) {
  const edge = Number.parseFloat(design.faces.paper.phone.edge);
  // The stream pays its gutter outside the heading. The right-hand controls sit on the web edge.
  const marginRight = edge - space.deckCompact - mailSize.edge;
  return (
    <View style={{ marginLeft: "auto", marginRight, flexDirection: "row", alignItems: "center", gap: 8 }}>
      {settled && fresh > 0 ? (
        <Txt variant="caption" tone="ink2" tabular accessibilityLabel={Copy.metaNew(fresh)}>{Copy.streamFreshCount(fresh)}</Txt>
      ) : null}
      {children}
    </View>
  );
}
