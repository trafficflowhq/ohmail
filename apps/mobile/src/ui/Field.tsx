/**
 * A labelled field, in the line shape the rest of the product's forms use. `packages/ui`'s
 * `TextField` is the reference — a rule under the text rather than a box around it — and it is a
 * DOM component, so this is the React Native half of that idiom. One field, not one per screen:
 * `connect.tsx` had its own copy and the standalone door would have made two — two fields are
 * two answers to "how does a form look here", and the second always misses the next a11y fix.
 * The secret arm never leaves this component: a `secret` field's value is not logged, not put in
 * an accessibility label, not echoed into any sentence — the reveal toggle only changes what the
 * platform draws. Nothing here calls `console`.
 */
import { type ReactNode } from "react";
import { TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";

export interface FieldProps {
  value: string;
  onChange: (v: string) => void;
  /** The visible label, and the accessible name — one string, so they cannot disagree. */
  label: string;
  /** A quiet line under the field. Absent renders nothing at all, not an empty line. */
  hint?: string;
  /**
   * The server's own sentence about this field, or absent.
   *
   * Rendered in `ink2`, which is this app's refusal tone (`Doors.tsx#Result`) — the phone's palette
   * has no danger colour and inventing one for a form would put a value outside the face ladder
   * that `theme.test.ts` holds.
   */
  error?: string;
  /** A press offered beside the error — the host a refusal named, where there is a field for it. */
  offer?: { label: string; onPress: () => void };
  /** `true` ⇒ the platform masks it and a reveal toggle is offered. */
  secret?: boolean;
  /** The reveal toggle's two labels. Required with `secret`: an unlabelled toggle is not a control. */
  revealLabels?: { show: string; hide: string };
  revealed?: boolean;
  onReveal?: (next: boolean) => void;
  /** Passed straight through: keyboard, autofill hint, return key, the autocapitalize arm. */
  input?: Pick<
    TextInputProps,
    | "autoCapitalize"
    | "autoComplete"
    | "autoCorrect"
    | "inputMode"
    | "keyboardType"
    | "onSubmitEditing"
    | "returnKeyType"
    | "textContentType"
  >;
  /** Focus target — the form hands its first field one so a step lands on the work. */
  inputRef?: React.Ref<TextInput>;
  children?: ReactNode;
}

export function Field({
  value,
  onChange,
  label,
  hint,
  error,
  offer,
  secret,
  revealLabels,
  revealed,
  onReveal,
  input,
  inputRef,
}: FieldProps) {
  const t = useTheme();
  const masked = secret === true && revealed !== true;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
      <Txt variant="sectionLabel" tone="ink3" style={{ paddingBottom: 4 }}>
        {label}
      </Txt>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: t.c.hair,
        }}
      >
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
          autoCapitalize="none"
          {...input}
          secureTextEntry={masked}
          accessibilityLabel={label}
          style={[t.type.msgBody, { color: t.c.ink, paddingVertical: 10, flex: 1 }]}
        />
        {secret === true && revealLabels !== undefined && onReveal !== undefined ? (
          <Tap
            onPress={() => onReveal(revealed !== true)}
            accessibilityRole="button"
            /* The label says what the press WILL do, which is what a screen reader has to
               announce; `accessibilityState.expanded` is not this control's vocabulary. */
            accessibilityLabel={masked ? revealLabels.show : revealLabels.hide}
            style={{ paddingVertical: 8, paddingHorizontal: 4 }}
          >
            <Txt variant="caption" tone="accent">
              {masked ? revealLabels.show : revealLabels.hide}
            </Txt>
          </Tap>
        ) : null}
      </View>
      {error !== undefined ? (
        <Txt variant="caption" tone="ink2" style={{ marginTop: 6 }} accessibilityRole="alert">
          {error}
        </Txt>
      ) : null}
      {offer !== undefined ? (
        <Tap
          onPress={offer.onPress}
          accessibilityRole="button"
          accessibilityLabel={offer.label}
          style={{ paddingVertical: 6 }}
        >
          <Txt variant="caption" tone="accent">
            {offer.label}
          </Txt>
        </Tap>
      ) : null}
      {hint !== undefined ? (
        <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}
