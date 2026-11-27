/**
 * A recipient field — To, Cc or Bcc — with the web field's suggestions: while it is typed in, the
 * known correspondents the part being typed matches stand under it (`live.ts#recipientSuggestions`),
 * and a press writes the one picked in place of that part. The value stays the one typed string.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Keyboard, Platform, TextInput, View } from "react-native";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { joinRecipients } from "@ohmail/app-logic/writing/recipient-lines";
import { Copy } from "../copy";
import { parseRecipients, recipientLine, recipientSuggestions, withSuggestion, type AddressBookEntry } from "../state/live";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { MailAvatar } from "./MailAvatar";

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

export const composeLabelWidth = 68;
export const composeLine = { flexDirection: "row", alignItems: "center", gap: 8 } as const;

const accepts = (text: string) => parseRecipients(text)?.length === 1;
const chipHeight = 36;

export function RecipientInput({
  label, value, onChangeText, editable, book, placeholder = Copy.composeToPlaceholder, autoFocus, ref, onFocus, onBlur, back, plain, trailing,
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
  plain?: boolean;
  trailing?: ReactNode;
}) {
  const t = useTheme();
  const own = useRef<TextInput | null>(null);
  const field = ref ?? own;
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const line = plain && t.mail ? recipientLine(value) : null;
  const tookTail = line !== null && (!typing || !editable) && accepts(line.tail);
  const chips = line === null ? [] : tookTail ? [...line.entries, line.tail.trim()] : line.entries;
  const text = line === null ? value : tookTail ? "" : line.tail;
  const offered = open && editable ? recipientSuggestions(book(), text) : NONE;
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
  const type = (next: string) => {
    setOpen(true);
    if (line === null) { onChangeText(next); return; }
    setTyping(true);
    const pasted = recipientLine(next, true);
    const takeLast = pasted.entries.length > 0 && accepts(pasted.tail);
    onChangeText(joinRecipients(
      takeLast ? [...chips, ...pasted.entries, pasted.tail.trim()] : [...chips, ...pasted.entries],
      takeLast ? "" : pasted.tail,
    ));
  };
  const remove = (at: number) => {
    onChangeText(joinRecipients(chips.filter((_, index) => index !== at), text));
    field.current?.focus();
  };
  const entry = (
    <TextInput
      ref={field}
      maxFontSizeMultiplier={t.textCap}
      disableFullscreenUI
      keyboardAppearance={t.scheme}
      underlineColorAndroid={plain ? "transparent" : undefined}
      value={text}
      onChangeText={type}
      onFocus={() => { setOpen(true); onFocus?.(); }}
      onBlur={() => { setOpen(false); setTyping(false); onBlur?.(); }}
      submitBehavior={line === null ? undefined : "submit"}
      onSubmitEditing={line === null ? undefined : () => { setOpen(false); setTyping(false); }}
      onKeyPress={line === null ? undefined : (event) => {
        if (editable && event.nativeEvent.key === "Backspace" && text === "" && chips.length > 0) remove(chips.length - 1);
      }}
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
        { flex: 1, minWidth: line === null ? 0 : 44, color: t.c.ink, backgroundColor: plain ? "transparent" : t.c.tint2,
          borderRadius: t.radius.pill, paddingHorizontal: plain ? 0 : 14, paddingVertical: 8 },
        plain && Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null,
      ]}
    />
  );
  return (
    <View style={{ gap: 4 }}>
      <View style={line === null ? composeLine : [composeLine, { alignItems: "flex-start" }]}>
        <Txt variant={plain ? "button" : "caption"} tone={plain ? "ink2" : "ink3"}
          style={plain ? { width: composeLabelWidth, paddingTop: line === null ? 0 : 8 } : undefined}>
          {label}
        </Txt>
        {line === null ? <>{entry}{trailing}</> : (
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
            {chips.map((raw, index) => {
              const recipient = parseRecipients(raw)?.[0];
              const address = recipient ? displayAddress(recipient.address) : raw;
              const name = recipient?.name ?? address;
              return (
                <View key={`${index}:${raw}`} style={{
                  flexDirection: "row", alignItems: "center", gap: 4,
                  maxWidth: "100%", minHeight: chipHeight, paddingLeft: 7, paddingRight: editable ? 0 : 8,
                  backgroundColor: t.c.tint2, borderRadius: t.radius.pill,
                  ...(!recipient ? { borderColor: t.c.ink, borderWidth: 2 } : {}),
                }}>
                  {recipient ? <MailAvatar person={{ name, address }} size={mailSize.avatarBadge} />
                    : <Icon name="info" size={14} color={t.c.ink2} />}
                  <Txt variant="button" numberOfLines={1} style={{ flexShrink: 1 }}
                    accessibilityLabel={recipient ? (name === address ? address : `${name}, ${address}`) : Copy.composeRecipientRefused(name)}>
                    {name}
                  </Txt>
                  {editable ? <Tap accessibilityRole="button" accessibilityLabel={Copy.composeRemoveRecipient(name)}
                    onPress={() => remove(index)} style={{ width: chipHeight, minHeight: chipHeight, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="x" size={13} color={t.c.ink2} />
                  </Tap> : null}
                </View>
              );
            })}
            {entry}
            {trailing}
          </View>
        )}
      </View>
      {offered.map((entry) => (
        <Tap
          key={entry.address}
          accessibilityRole="button"
          accessibilityLabel={Copy.composeSuggestion(entry.name, entry.address)}
          onPress={() => {
            onChangeText(withSuggestion(value, entry));
            if (line !== null) setOpen(false);
            field.current?.focus();
          }}
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
