/**
 * Shared disclosures. Task sheets carry a dismissing row. Paper menus use the compact
 * phone web panel and a named backdrop within the accessible overlay.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { useKeyboardHeight, useKeyboardLift } from "./keyboard-lift";
import { useReaderCover } from "./reader-cover";
import { creaseAcross, separatingVerticalHinge, usePosture } from "./posture";
import { detailPaneRect, scaffoldPlan } from "./scaffold/plan";
import { phoneMenuBounds, sheetPanelBounds, sheetRoom, type SheetAnchor } from "./sheet-bounds";
import { Button, Tap, Txt } from "./base";
import { HeadingEnd } from "./HeadingEnd";
import { Icon, NavigationIcon, type IconName, type NavigationIconName } from "./Icon";

const { menuRowHeight, menuRowInset } = mailSize;
const InPhoneMenu = createContext(false);

type SheetConfirmation = {
  note: string;
  action: { label: string; onPress: () => void };
};

/**
 * WHERE A SHEET'S PANEL MAY STAND, per posture: a menu never straddles the hinge or the panes
 * (Apple moves "alerts and menus … away from the bend"; Microsoft: never across the seam). On a
 * two-pane posture the panel rises over the DETAIL PANE — the side the verbs belong to — whose
 * rect comes from the pair's own split (`detailPaneRect`); over a HORIZONTAL hinge (tabletop) it
 * stays inside the lower half. One pane keeps the thumb sheet. Shared with the composer's modal.
 */
export function useSheetPanelBounds(floatOnPhone = false): ViewStyle {
  const { width: w, height: h } = useWindowDimensions();
  const posture = usePosture();
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const pane = detailPaneRect(posture, plan, { w, h }, insets);
  /* One pane hands no hinge (a flat fold has no width), except a book fold, which a sheet keeps off. */
  const hinge = posture.panes === 2 || separatingVerticalHinge(posture.fold, posture.hinge) !== null ? posture.hinge : null;
  if (floatOnPhone && pane === null && hinge === null) {
    return sheetPanelBounds(w, h, insets.top, pane, hinge, {
      gutter: plan.gutter,
      radius: t.radius.panel,
      inset: mailSize.inset + Math.max(insets.left, insets.right),
    });
  }
  return sheetPanelBounds(w, h, insets.top, pane, hinge, { gutter: plan.gutter, radius: t.radius.panel });
}

/** The room a sheet rises in, above the keyboard and, over a crease, above the crease (`sheetRoom`). */
export function useSheetRoom(keyboardLift: number): ViewStyle {
  const { height: h } = useWindowDimensions();
  const posture = usePosture();
  const insets = useSafeAreaInsets();
  return sheetRoom(insets.top, keyboardLift, creaseAcross(posture.fold, posture.hinge), h);
}

/**
 * A `Modal`'s key: on Android its dialog keeps the size it measured in the OLD density when the
 * display size changes (the pixels do not move, so nothing re-measures), and the panel runs off the
 * screen. Keying the dialog on the scale opens a fresh one; the content's state lives above it.
 */
export function useModalKey(): string {
  return `density-${useWindowDimensions().scale}`;
}

/**
 * The bottom sheet: a backdrop press away from dismissal, the panel where the thumb is.
 * `avoidKeyboard` lifts the panel over the keyboard for a sheet that holds a text input
 * (the folders name sheet) — the composer's own `KeyboardAvoidingView` arrangement.
 */
export function Sheet({
  open,
  onClose,
  onDismiss,
  label,
  avoidKeyboard,
  cancel,
  children,
  phoneMenu,
  title,
  aside,
  anchor,
  anchorAlign,
  anchorSide,
  inlineAnchor,
  confirmation,
}: {
  open: boolean;
  onClose: () => void;
  /** Keep the native modal mounted until UIKit completes dismissal. */
  onDismiss?: () => void;
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
  phoneMenu?: boolean | "card";
  title?: string;
  aside?: string;
  anchor?: SheetAnchor;
  anchorAlign?: "start" | "end";
  anchorSide?: "above" | "below";
  /** The caller already owns the window's overlay host. Place this after its content. */
  inlineAnchor?: boolean;
  /** A safety question after a phone menu selection, on that same accessible overlay. */
  confirmation?: SheetConfirmation;
}) {
  if (phoneMenu) return open || onDismiss ? (
    <PhoneMenu open={open} label={label} onClose={onClose} onDismiss={onDismiss} title={title} aside={aside} anchor={anchor}
      align={anchorAlign} side={anchorSide} inline={inlineAnchor} card={phoneMenu === "card"} confirmation={confirmation}>
      {children}
    </PhoneMenu>
  ) : null;
  return <TaskSheet {...{ open, onClose, onDismiss, label, avoidKeyboard, cancel, children }} />;
}

function TaskSheet({ open, onClose, onDismiss, label, avoidKeyboard, cancel, children }: {
  open: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  label: string;
  avoidKeyboard?: boolean;
  cancel?: "own";
  children: ReactNode;
}) {
  const t = useTheme();
  const keyboardLift = useKeyboardLift();
  const insets = useSafeAreaInsets();
  const bounds = useSheetPanelBounds(t.mail === true);
  const room = useSheetRoom(keyboardLift);
  const modalKey = useModalKey();
  /* A shown sheet stands over the reader: nothing under it is read (`reader-cover.ts`). */
  useReaderCover(open);
  if (!open && !onDismiss) return null;
  const body = (
    <>
      <SheetBackdrop label={Copy.moveCancel} onPress={onClose} />
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
            flexShrink: 1,
          },
          bounds,
          t.liftUp("l3"),
        ]}
      >
        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} bounces={false} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {children}
        </ScrollView>
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
    <Modal key={modalKey} transparent statusBarTranslucent navigationBarTranslucent
      animationType={t.reduceMotion ? "none" : "slide"} visible={open} onRequestClose={onClose} onDismiss={onDismiss}>
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={room}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        <View style={{ flex: 1, justifyContent: "flex-end" }}>{body}</View>
      )}
    </Modal>
  );
}

function PhoneMenu({ open, label, onClose, onDismiss, title, aside, anchor, align = "start", side = "below", inline, card, confirmation, children }: {
  open: boolean;
  label: string;
  onClose: () => void;
  onDismiss?: () => void;
  title?: string;
  aside?: string;
  anchor?: SheetAnchor;
  align?: "start" | "end";
  side?: "above" | "below";
  inline?: boolean;
  card: boolean;
  confirmation?: SheetConfirmation;
  children: ReactNode;
}) {
  const t = useTheme();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const keyboardHeight = useKeyboardHeight();
  const modalKey = useModalKey();
  const [contentHeight, setContentHeight] = useState(menuRowHeight);
  const padding = card ? menuRowInset : mailSize.inset;
  const hinge = separatingVerticalHinge(posture.fold, posture.hinge) ?? creaseAcross(posture.fold, posture.hinge);
  const bounds = phoneMenuBounds(window, insets, keyboardHeight, hinge, { anchor, align, side, contentHeight });
  useReaderCover(open);
  useEffect(() => {
    if (!inline || !open) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => subscription.remove();
  }, [inline, onClose, open]);
  const edge = mailSize.edge;
  const room: ViewStyle | undefined = confirmation ? {
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: Math.max(edge, insets.left, insets.right),
    paddingVertical: Math.max(edge, insets.top, insets.bottom),
    ...(keyboardHeight > 0 ? { paddingBottom: keyboardHeight + edge } : {}),
    ...(hinge === null ? {} : hinge.h < hinge.w
      ? { paddingTop: hinge.y + hinge.h + edge }
      : { paddingLeft: hinge.x + hinge.w + edge }),
  } : undefined;
  const body = (
    <View accessibilityViewIsModal onAccessibilityEscape={onClose}
      style={[StyleSheet.absoluteFill, { zIndex: t.zLayer.sheet }, room]}>
      <SheetBackdrop label={Copy.moveCancel} onPress={onClose} />
      <View accessibilityLabel={label} accessibilityRole={confirmation ? "alert" : "menu"} onAccessibilityEscape={onClose} style={[
        { backgroundColor: t.c.float, borderRadius: t.radius.panel },
        t.lift("l3"),
        confirmation ? { width: "100%", maxWidth: 480, padding: edge * 2, flexShrink: 1 } : [
          { position: "absolute", padding },
          bounds,
        ],
      ]}>
        {confirmation ? (
          <>
            <Txt variant="h2" accessibilityRole="header">
              <HeadingEnd variant="h2" hot>{label}</HeadingEnd>
            </Txt>
            <Txt variant="body" tone="ink2" style={{ marginTop: mailSize.inset }}>{confirmation.note}</Txt>
            <ScrollView style={{ flexGrow: 0, flexShrink: 1, marginTop: edge }} bounces={false}>
              {children}
            </ScrollView>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: mailSize.inset, marginTop: edge + mailSize.inset }}>
              <Button label={confirmation.action.label} variant="solid" onPress={confirmation.action.onPress}
                style={{ minHeight: menuRowHeight, paddingHorizontal: edge + mailSize.inset }} />
              <Button label={Copy.moveCancel} variant="quiet" onPress={onClose} style={{ minHeight: menuRowHeight }} />
            </View>
          </>
        ) : (
          <InPhoneMenu.Provider value>
            <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} bounces={false} keyboardShouldPersistTaps="handled" nestedScrollEnabled
              onContentSizeChange={(_, height) => setContentHeight(height + 2 * padding)}>
              {title ? (
                <View style={{
                  flexDirection: "row", justifyContent: "space-between", paddingTop: mailSize.inset,
                  paddingHorizontal: menuRowInset, paddingBottom: mailSize.rowInset,
                }}>
                  <Txt variant="railCount" tone="ink2">{title}</Txt>
                  {aside ? <Txt variant="meta" tone="ink2">{aside}</Txt> : null}
                </View>
              ) : null}
              {children}
            </ScrollView>
          </InPhoneMenu.Provider>
        )}
      </View>
    </View>
  );
  return inline ? open ? body : null : (
    <Modal key={modalKey} transparent statusBarTranslucent navigationBarTranslucent
      animationType={t.reduceMotion ? "none" : "fade"} visible={open} onRequestClose={onClose} onDismiss={onDismiss}>
      {body}
    </Modal>
  );
}

/**
 * THE SCRIM, over the whole window on every posture and in both themes: the Modal blocks every
 * touch, so what stands beside a pane-anchored panel or above a thumb sheet is drawn as inert, and
 * a press on it closes the sheet. Behind the panel (first child), never a flex spacer above it, so
 * the band beside a panel on the detail pane is covered too. Shared with the composer's modal.
 */
export function SheetBackdrop({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      style={[StyleSheet.absoluteFill, { backgroundColor: t.c.scrim }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
    />
  );
}

/**
 * One verb, one row. A row given `on` is a checkbox whose state is read out. On a row with no icon
 * (the Tag sheet's) the check stands in the icon's place, before the name: at the far end it went
 * unseen, and a tap removed the tag a person meant to add.
 */
export function SheetRow({
  label,
  detail,
  icon,
  navigationIcon,
  on,
  disabled,
  accessibilityHint,
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
  navigationIcon?: NavigationIconName;
  on?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const phoneMenu = useContext(InPhoneMenu);
  const sign = navigationIcon ? <NavigationIcon name={navigationIcon} size={18} color={t.c.ink} />
    : icon ? <Icon name={icon} size={phoneMenu ? 18 : 14} color={phoneMenu ? t.c.ink : t.c.ink2} /> : null;
  const row = {
    onPress,
    disabled,
    accessibilityHint,
    accessibilityLabel: detail === undefined ? label : Copy.ariaLabelDetail(label, detail),
    style: ({ pressed }: { pressed: boolean }) => ({
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingHorizontal: phoneMenu ? menuRowInset : 16,
      paddingVertical: phoneMenu ? mailSize.rowInset : 13,
      minHeight: phoneMenu ? menuRowHeight : undefined,
      borderRadius: phoneMenu ? t.radius.row : undefined,
      backgroundColor: pressed ? t.c.tint : "transparent",
      ...(disabled ? { opacity: 0.5 } : {}),
    }),
  };
  // The checkbox alone hands native a checked state. Key the two roles apart so a row that
  // changes kind cannot keep the old role's state.
  return on === undefined ? (
    <Tap key="button" {...row} accessibilityRole="button" accessibilityState={{ disabled: disabled === true }}>
      {rowContent(t, label, detail, sign, on, phoneMenu)}
    </Tap>
  ) : (
    <Tap key="checkbox" {...row} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: disabled === true }}>
      {rowContent(t, label, detail, sign, on, phoneMenu)}
    </Tap>
  );
}

function rowContent(
  t: ReturnType<typeof useTheme>, label: string, detail: string | undefined, sign: ReactNode,
  on: boolean | undefined, phoneMenu: boolean,
) {
  return (
    <>
      {on !== undefined && !sign && !phoneMenu ? (
        <View style={{ width: 14 }}>{on ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}</View>
      ) : null}
      {sign}
      {phoneMenu && on ? (
        <View style={{ flexDirection: "row", alignItems: "baseline", flexShrink: 1, gap: mailSize.rowInset }}>
          <Txt variant="button" style={{ flexShrink: 1 }}>{label}</Txt>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.ink }} />
        </View>
      ) : <Txt variant={phoneMenu ? "bodyMedium" : "button"} style={{ flexShrink: 1 }}>{label}</Txt>}
      <View style={{ flex: 1 }} />
      {detail === undefined ? null : (
        <Txt variant={phoneMenu ? "meta" : "note"} tone="ink2" numberOfLines={phoneMenu ? 1 : undefined}
          style={phoneMenu ? { maxWidth: "50%" } : undefined}>
          {detail}
        </Txt>
      )}
      {on && sign && !phoneMenu ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}
    </>
  );
}

/**
 * The way out, rendered by {@link Sheet} and by nobody else — unexported for that reason: a
 * caller that could render one could render a second beside the primitive's.
 */
function CancelRow({ onPress }: { onPress: () => void }) {
  return <SheetRow icon="x" label={Copy.moveCancel} onPress={onPress} />;
}
