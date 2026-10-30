/**
 * A recipient field — To, Cc or Bcc — with the web field's suggestions: while it is typed in, the
 * known correspondents the part being typed matches stand under it (`live.ts#recipientSuggestions`),
 * and a press writes the one picked in place of that part. The value stays the one typed string.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Keyboard, Platform, TextInput, View } from "react-native";
import { Copy } from "../copy";
import { recipientSuggestions, withSuggestion, type AddressBookEntry } from "../state/live";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";

const NONE: readonly AddressBookEntry[] = [];

/** Where an open suggestion list leaves its close, for the sheet's Back to take first. */
export type BackStep = { current: (() => void) | null };

/** Closes the open suggestion list, if one is open; false when Back is the sheet's. */
export function stepBack(step: BackStep): boolean {
  const close = step.current;
  if (close === null) return false;
  close();
  return true;
}

export function RecipientInput({
  label, value, onChangeText, editable, book, placeholder = Copy.composeToPlaceholder, autoFocus, ref, onFocus, onBlur, back,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  editable: boolean;
  /** Read only while the field is typed in: the book walks the whole mirror. */
  book: () => readonly AddressBookEntry[];
  placeholder?: string;
  autoFocus?: boolean;
  /** The input itself (a prop under React 19), for a caller that focuses it. */
  ref?: RefObject<TextInput | null>;
  onFocus?: () => void;
  onBlur?: () => void;
  back?: BackStep;
}) {
  const t = useTheme();
  const own = useRef<TextInput | null>(null);
  const field = ref ?? own;
  const [open, setOpen] = useState(false);
  const offered = open && editable ? recipientSuggestions(book(), value) : NONE;
  const shown = offered.length > 0;
  const hide = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (back === undefined || !shown) return undefined;
    back.current = hide;
    return () => { if (back.current === hide) back.current = null; };
  }, [back, shown, hide]);
  /* Android keeps the field focused when Back only hides the keyboard: the list goes with it. */
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const sub = Keyboard.addListener("keyboardDidHide", hide);
    return () => sub.remove();
  }, [hide]);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Txt variant="caption" tone="ink3">
          {label}
        </Txt>
        <TextInput
          ref={field}
          maxFontSizeMultiplier={t.textCap}
          value={value}
          onChangeText={(next) => { setOpen(true); onChangeText(next); }}
          onFocus={() => { setOpen(true); onFocus?.(); }}
          onBlur={() => { setOpen(false); onBlur?.(); }}
          editable={editable}
          autoFocus={autoFocus}
          placeholder={placeholder}
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
      {offered.map((entry) => (
        <Tap
          key={entry.address}
          accessibilityRole="button"
          accessibilityLabel={Copy.composeSuggestion(entry.name, entry.address)}
          onPress={() => { onChangeText(withSuggestion(value, entry)); field.current?.focus(); }}
          /* Rows stand 4 dp apart: grown slop would reach into the row above or the field. */
          hitSlop={0}
          style={{
            minHeight: t.hit, justifyContent: "center", paddingHorizontal: 14, paddingVertical: 6,
            borderRadius: t.radius.card, backgroundColor: t.c.tint2,
          }}
        >
          {entry.name !== "" ? <Txt>{entry.name}</Txt> : null}
          <Txt variant="caption" tone="ink3">
            {entry.address}
          </Txt>
        </Tap>
      ))}
    </View>
  );
}
