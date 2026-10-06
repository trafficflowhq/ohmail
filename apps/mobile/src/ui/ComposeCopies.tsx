/**
 * The Cc and Bcc fields of a new mail, drawn as To is (`compose-copies.ts` holds the rules). Only
 * mounted where the letter carries copies.
 */
import { TextInput, View } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { Txt } from "./base";
import type { TypedCopies } from "./compose-copies";

export function ComposeCopies({ value, editable, onChange }: {
  value: TypedCopies;
  editable: boolean;
  onChange: (next: TypedCopies) => void;
}) {
  const t = useTheme();
  const field = (label: string, text: string, set: (v: string) => void) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Txt variant="caption" tone="ink3">
        {label}
      </Txt>
      <TextInput
        value={text}
        onChangeText={set}
        editable={editable}
        placeholder={Copy.composeToPlaceholder}
        placeholderTextColor={t.c.ink3}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        style={[
          t.type.body,
          { flex: 1, color: t.c.ink, backgroundColor: t.c.tint2, borderRadius: t.radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
        ]}
      />
    </View>
  );
  return (
    <>
      {field(Copy.composeCc, value.cc, (cc) => onChange({ ...value, cc }))}
      {field(Copy.composeBcc, value.bcc, (bcc) => onChange({ ...value, bcc }))}
    </>
  );
}
