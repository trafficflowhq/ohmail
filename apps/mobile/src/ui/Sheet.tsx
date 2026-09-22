/**
 * THE BOTTOM SHEET AND ITS ROWS — the phone's one disclosure idiom, shared by every surface
 * that needs a menu (`MessageActions.tsx`, `FoldersGroup.tsx`). A popover has nowhere honest
 * to anchor on a phone, so the panel rises where the thumb is and the backdrop dismisses it.
 * EVERY SHEET CARRIES A WAY OUT ON THE PANEL: the backdrop is the modal panel's sibling, so
 * assistive technology never sees it, and a sheet of verbs alone read as six buttons and no
 * exit on the Duo. A CancelRow or a dismissing row of the sheet's own is the invariant
 * (`test/sheet-has-a-cancel.test.ts`).
 */
import type { ReactNode } from "react";
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, useWindowDimensions, View, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { usePosture } from "./posture";
import { Tap, Txt } from "./base";
import { Icon, type IconName } from "./Icon";

/**
 * WHERE A SHEET'S PANEL MAY STAND, per posture: a menu never straddles the hinge (Apple moves
 * "alerts and menus … away from the bend"; Microsoft: never across the seam). Beside a
 * VERTICAL two-pane hinge the panel rises over the reading half — the side the verbs live
 * on — its left edge past the fold; over a HORIZONTAL one (tabletop) it stays inside the
 * lower half. On any other wide window it is bounded and centered (the form-sheet shape);
 * compact keeps the full-width thumb sheet, unchanged. Shared with the composer's own modal.
 */
export function useSheetPanelBounds(): ViewStyle {
  const { width: w, height: h } = useWindowDimensions();
  const posture = usePosture();
  const hinge = posture.panes === 2 ? posture.hinge : null;
  if (hinge !== null && hinge.h >= hinge.w) {
    return { alignSelf: "flex-end", width: Math.max(320, w - (hinge.x + hinge.w)) };
  }
  if (hinge !== null) {
    return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: Math.max(280, h - (hinge.y + hinge.h)) };
  }
  return { alignSelf: "center", width: "100%", maxWidth: 560 };
}

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
  cancel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  avoidKeyboard?: boolean;
  /**
   * `"own"` for a sheet that already renders its own dismissing row — a confirmation whose
   * pair is the point (Stop / Cancel, Delete / Cancel). Anything else gets the primitive's
   * row, so a sheet with nothing to press cannot be written. `sheet-has-a-cancel.test.ts`
   * refuses an `"own"` whose children carry no such row.
   */
  cancel?: "own";
  children: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const bounds = useSheetPanelBounds();
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
          bounds,
          t.liftUp("l3"),
        ]}
      >
        {children}
        {/* THE WAY OUT IS THE PRIMITIVE'S, not each caller's. The reader's More sheet shipped
            with six verbs and no dismiss control: a pointer drags the panel down, and a screen
            reader, a switch or a keyboard has nothing to press. The row is rendered here so a
            sheet without one cannot be written; `cancel="own"` is for the confirmations that
            carry their own pair. */}
        {cancel === "own" ? null : <CancelRow onPress={onClose} />}
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
  detail,
  icon,
  on,
  onPress,
}: {
  label: string;
  /**
   * The row's VALUE, right-aligned — the platform's settings-row idiom ("Tomorrow    14:30").
   * Deliberately not folded into {@link label}: the label is the row's accessible name and the
   * verb parity guard reads it, so a composed string would rename the verb to say a value. The
   * detail joins the accessible name as a second string, so a screen reader hears both.
   */
  detail?: string;
  icon?: IconName;
  on?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail === undefined ? label : Copy.ariaLabelDetail(label, detail)}
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
      {detail === undefined ? null : (
        <Txt variant="note" tone="ink2">
          {detail}
        </Txt>
      )}
      {on ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}
    </Tap>
  );
}

/**
 * The way out, rendered by {@link Sheet} and by nobody else — unexported for that reason: a
 * caller that could render one could render a second beside the primitive's.
 */
function CancelRow({ onPress }: { onPress: () => void }) {
  return <SheetRow icon="x" label={Copy.moveCancel} onPress={onPress} />;
}
