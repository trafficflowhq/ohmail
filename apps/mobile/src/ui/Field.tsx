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
import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";
import { onboardingLook } from "../theme/onboarding";
import { onboardingDisplay } from "../theme/type";

export interface FieldProps {
  value: string;
  onChange: (v: string) => void;
  /** The accessible name, also shown above the ordinary field. */
  label: string;
  /** The accessible name stays the label even when a sentence surrounds the native input. */
  sentence?: {
    before: string;
    placeholder: string;
    compact?: boolean;
    end?: "ink" | "hot";
    after?: string;
  };
  boxed?: boolean;
  locked?: boolean;
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
  /**
   * Passed straight through: keyboard, autofill hint, return key, the autocapitalize arm — and
   * `multiline`, for the one field in this app that holds PROSE (the away responder's message).
   * Widened here rather than answered with a second field component: this file's own rule is that
   * two fields are two answers to "how does a form look here", and the second always misses the
   * next accessibility fix.
   */
  input?: Pick<
    TextInputProps,
    | "autoCapitalize"
    | "autoComplete"
    | "autoCorrect"
    | "importantForAutofill"
    | "inputMode"
    | "keyboardType"
    | "multiline"
    | "onSubmitEditing"
    | "returnKeyType"
    | "selectTextOnFocus"
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
  sentence,
  boxed,
  locked,
}: FieldProps) {
  const t = useTheme();
  const masked = secret === true && revealed !== true;
  const look = sentence || boxed ? onboardingLook(t) : null;
  const display = sentence && look ? onboardingDisplay(look.type, sentence.compact) : null;
  const ink = look?.palette.ink ?? t.c.ink;
  const quiet = look?.palette.ink2 ?? t.c.ink2;
  const wrapsAddress = display !== null && !secret && input?.keyboardType === "email-address";
  const multiline = wrapsAddress || input?.multiline === true;
  const dotted = { borderBottomWidth: 2, borderStyle: "dotted", borderColor: ink } as const;
  const blank = (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={wrapsAddress ? (text) => onChange(text.replace(/[\r\n]/g, "")) : onChange}
      autoCorrect={false}
      autoCapitalize="none"
      {...input}
      maxFontSizeMultiplier={t.textCap}
      disableFullscreenUI
      keyboardAppearance={t.scheme}
      secureTextEntry={masked}
      accessibilityLabel={label}
      editable={locked ? false : undefined}
      placeholder={sentence?.placeholder}
      placeholderTextColor={sentence ? quiet : undefined}
      /* A prose field grows: it starts at about five lines, aligns to the top rather than
         centring one line in a tall box, and the row above it stops centring with it. */
      multiline={multiline}
      submitBehavior={wrapsAddress ? "submit" : undefined}
      textAlignVertical={multiline ? "top" : "center"}
      style={[
        display
          ? [
              { ...display, color: ink },
              wrapsAddress
                ? { ...dotted, minHeight: t.hit, minWidth: t.hit, maxWidth: "100%", paddingVertical: 0 }
                : [StyleSheet.absoluteFill, { paddingVertical: 3 }],
            ]
          : [t.type.msgBody, { color: ink, paddingVertical: 10, flex: 1 }],
        input?.multiline === true ? { minHeight: 112 } : null,
      ]}
    />
  );
  const reveal = secret === true && revealLabels !== undefined && onReveal !== undefined ? (
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
    ) : null;
  const after = sentence?.after && display ? <Txt style={{ ...display, color: ink }}>{sentence.after}</Txt> : null;
  const end = sentence?.end && display ? (
    <View style={{ backgroundColor: sentence.end === "ink" ? ink : look?.palette.hot,
      width: display.fontSize * 0.33, height: display.fontSize * 0.33,
      borderRadius: display.fontSize, marginLeft: display.fontSize * 0.08 }} />
  ) : null;
  return (
    <View style={sentence || boxed ? undefined : { paddingHorizontal: 16, paddingTop: 12 }}>
      {sentence && display ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 4 }}>
            {sentence.before ? <Txt style={{ ...display, color: ink }}>{sentence.before}</Txt> : null}
            {wrapsAddress ? (
              // The native editor measures its value or placeholder. Let the trailing word wrap
              // with the sentence and give the editor up to a whole line to draw the address.
              <>
                {blank}
                {after}
                {end}
              </>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", maxWidth: "100%" }}>
                <View style={{
                  ...dotted, minHeight: t.hit, minWidth: t.hit, flexShrink: 1, justifyContent: "center",
                }}>
                  {/* The public placeholder sizes the blank. Typed credentials never enter the measuring text. */}
                  <Txt accessible={false} importantForAccessibility="no" style={{ ...display, opacity: 0 }}>
                    {sentence.placeholder}
                  </Txt>
                  {blank}
                </View>
                {after}
                {end}
              </View>
            )}
          </View>
          {value === "" ? null : reveal}
        </>
      ) : (
        <>
          <Txt variant="sectionLabel" tone="ink3" style={[{ paddingBottom: 4 }, boxed ? { color: quiet } : undefined]}>
            {label}
          </Txt>
          <View style={{
            flexDirection: "row",
            alignItems: input?.multiline === true ? "flex-start" : "center",
            gap: 8,
            borderBottomWidth: 1,
            borderBottomColor: t.c.hair,
            ...(boxed && look ? {
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: look.palette["ctl-ring"],
              borderBottomColor: look.palette["ctl-ring"],
              backgroundColor: look.palette.sheet,
              borderRadius: 12,
            } : {}),
          }}>
            {blank}
            {reveal}
          </View>
        </>
      )}
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
