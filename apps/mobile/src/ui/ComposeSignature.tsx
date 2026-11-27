import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { Button, Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { linkedText, MailLinkSheet, useMailLinks } from "./MailLinks";

export function ComposeSignature({ text, html, disabled, editor, onRemove }: {
  text: string;
  html: string | null;
  disabled: boolean;
  editor: ReactNode;
  onRemove: () => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const links = useMailLinks();
  return (
    <View style={{ paddingHorizontal: 14 }}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={Copy.sigLabel}
        accessibilityState={{ expanded: open }}
        onPress={() => { setOpen(!open); setEditing(false); }}
        style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", minHeight: 36, gap: 6 }}
      >
        <Txt variant="caption" tone="ink3" numberOfLines={1}>{Copy.sigLabel}</Txt>
        <Icon name={open ? "down" : "chev"} size={12} color={t.c.ink3} />
      </Tap>
      {open ? (
        <>
          {editing ? editor : (
            <ScrollView style={{ maxHeight: 144 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              <Txt variant="note" tone="ink2">{linkedText(text, t, links.open, { signatureHtml: html })}</Txt>
            </ScrollView>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
            <Button label={editing ? Copy.sigDoneEditing : Copy.sigEditAsText} variant="quiet" disabled={disabled} onPress={() => setEditing(!editing)} />
            <Tap
              onPress={onRemove}
              disabled={disabled}
              accessibilityState={{ disabled: disabled === true }}
              accessibilityRole="button"
              accessibilityLabel={Copy.sigRemove}
              style={{ padding: 8 }}
            >
              <Icon name="x" size={13} color={t.c.ink3} />
            </Tap>
          </View>
        </>
      ) : null}
      {links.url !== null ? <MailLinkSheet url={links.url} onClose={links.close} /> : null}
    </View>
  );
}
