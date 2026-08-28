/**
 * THE BOTTOM SHEET AND ITS ROWS — the phone's one disclosure idiom, shared by every surface
 * that needs a menu (the message verbs' sheets in `MessageActions.tsx`; the folders group's
 * verb and name sheets in `FoldersGroup.tsx`). A popover has nowhere honest to anchor on a
 * phone, so the panel rises where the thumb is and a backdrop press dismisses it.
 *
 * Lifted out of `MessageActions.tsx` when the folders group gained its verbs — one sheet, not
 * two drifting copies.
 */
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";
import { Icon, type IconName } from "./Icon";

/**
 * The bottom sheet: a backdrop press away from dismissal, the panel where the thumb is.
 * `avoidKeyboard` lifts the panel over the keyboard for a sheet that holds a text input
 * (the folders name sheet) — the composer's own `KeyboardAvoidingView` arrangement.
 */
export function Sheet({
  open,
  onClose,
  label,
  avoidKeyboard,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  avoidKeyboard?: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!open) return null;
  const body = (
    <>
      <Pressable style={{ flex: 1 }} accessibilityLabel={Copy.moveCancel} onPress={onClose} />
      <View
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={[
          {
            backgroundColor: t.c.float,
            borderTopLeftRadius: t.radius.panel,
            borderTopRightRadius: t.radius.panel,
            paddingTop: 12,
            paddingBottom: 8 + insets.bottom,
          },
          t.liftUp("l3"),
        ]}
      >
        {children}
      </View>
    </>
  );
  return (
    <Modal transparent animationType={t.reduceMotion ? "none" : "slide"} visible onRequestClose={onClose}>
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        <View style={{ flex: 1, justifyContent: "flex-end" }}>{body}</View>
      )}
    </Modal>
  );
}

/** One verb, one row. `on` draws the check — the tag sheet's assigned mark. */
export function SheetRow({
  label,
  icon,
  on,
  onPress,
}: {
  label: string;
  icon?: IconName;
  on?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 13,
        backgroundColor: pressed ? t.c.tint : "transparent",
      })}
    >
      {icon ? <Icon name={icon} size={14} color={t.c.ink2} /> : null}
      <Txt variant="button" style={{ flexShrink: 1 }}>
        {label}
      </Txt>
      <View style={{ flex: 1 }} />
      {on ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}
    </Tap>
  );
}

export function CancelRow({ onPress }: { onPress: () => void }) {
  return <SheetRow icon="x" label={Copy.moveCancel} onPress={onPress} />;
}
