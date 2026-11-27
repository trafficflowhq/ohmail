import type { ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { mailColors, mailSize } from "../theme/mail";
import { Txt } from "./base";
import { MailboxChip } from "./MailboxChip";

export function MailRowByline({ name, address, time, seen, mailbox, keepAddress, children }: {
  name: string;
  address?: string;
  time: string;
  seen: boolean;
  mailbox?: string;
  keepAddress?: boolean;
  children?: ReactNode;
}) {
  const t = useTheme();
  const readInk = t.mail ? mailColors(t)["ink-read"] : t.c.ink2;
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: mailSize.inset }}>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: mailSize.inset }}>
        <Txt variant={seen ? "rowSenderSeen" : "rowSender"} numberOfLines={1}
          ellipsizeMode={keepAddress && name === address ? "head" : undefined}
          style={{ flexShrink: 1, minWidth: 0, color: seen ? readInk : t.c.ink }}
        >
          {name}
        </Txt>
        {address && address !== name ? (
          <Txt variant="caption" tone="ink2" numberOfLines={1}
            ellipsizeMode={keepAddress ? "head" : undefined}
            style={keepAddress ? { maxWidth: "78%", flexShrink: 0 }
              : t.mail ? { flexBasis: 0, flexGrow: 1, minWidth: 0 } : { flexShrink: 2, minWidth: 0 }}
          >
            {address}
          </Txt>
        ) : null}
      </View>
      {children}
      {mailbox ? <MailboxChip label={mailbox} withinRow /> : null}
      <Txt variant="caption" tone="ink2" numberOfLines={1} tabular style={{ flexShrink: 0 }}>{time}</Txt>
    </View>
  );
}
