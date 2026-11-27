import type { RestingSearchPerson } from "@ohmail/app-logic/search/people";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { mailSize } from "../theme/mail";
import { MailAvatar } from "./MailAvatar";
import { Tap, Txt } from "./base";

export function SearchHeading({ title, count, aside, hot }: {
  title: string; count?: string; aside?: ReactNode; hot?: boolean;
}) {
  return (
    <View style={{
      minHeight: 44, paddingHorizontal: mailSize.edge - mailSize.rowInset,
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: mailSize.inset,
    }}>
      <Txt variant="sectionLabel" accessibilityRole="header" style={{ flexShrink: 1 }}>
        {title}<Txt variant="sectionLabel" tone={hot ? "accent" : "ink"}>.</Txt>
        {count === undefined ? null : <> <Txt variant="caption" tone="ink2" tabular>{count}</Txt></>}
      </Txt>
      {aside}
    </View>
  );
}

export function SearchPersonRow({ entry, resting, onPick }: {
  entry: RestingSearchPerson; resting: boolean; onPick: () => void;
}) {
  const { person, from, to } = entry;
  const name = person.name || person.address;
  const address = person.name && person.name !== person.address ? person.address : null;
  const amount = from === 0 ? Copy.searchPeopleTo(to) : to === 0 ? Copy.searchPeopleFrom(from) : Copy.searchPeopleBoth(from, to);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={[name, address, amount].filter(Boolean).join(", ")}
      onPress={onPick}
      style={{
        minHeight: resting ? mailSize.bar + mailSize.rowInset : mailSize.row,
        paddingHorizontal: mailSize.edge - mailSize.rowInset, paddingVertical: mailSize.inset,
        flexDirection: "row", alignItems: "center", gap: mailSize.inset,
      }}
    >
      <MailAvatar person={person} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: mailSize.inset }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: mailSize.rowInset }}>
            <Txt variant={resting ? "bodyMedium" : "rowSenderSeen"} numberOfLines={1} style={{ flexShrink: 1 }}>{name}</Txt>
            {!resting && address ? (
              <Txt variant="caption" tone="ink2" numberOfLines={1} style={{ flexShrink: 4, minWidth: 0 }}>{address}</Txt>
            ) : null}
          </View>
          <Txt variant="caption" tone="ink2" tabular numberOfLines={1} style={{ maxWidth: "56%" }}>{amount}</Txt>
        </View>
        {resting && address ? <Txt variant="caption" tone="ink2" numberOfLines={1}>{address}</Txt> : null}
      </View>
    </Tap>
  );
}
