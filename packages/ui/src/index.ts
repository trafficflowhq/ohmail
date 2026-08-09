/**
 * @ohmail/ui — the Blanc design system as React components.
 *
 * Structure is read from light falloff: white panels on an off-white
 * canvas, sculpted by the four-step lift shadow ladder instead of
 * borders. Tokens come from @ohmail/tokens (fidelity-locked against
 * the canonical prototype); wrap your app in an element with the
 * `mo-canvas` class to get the ground styles.
 */
import "@ohmail/tokens/tokens.css";
import "./base.css";

/* theme */
export { ThemeProvider, useTheme, useOptionalTheme, themeInitScript } from "./theme/ThemeProvider.js";
export type {
  ThemePreference,
  ResolvedTheme,
  ThemeContextValue,
  ThemeProviderProps,
} from "./theme/ThemeProvider.js";

/* icons */
export { Icon, ICON_PATHS } from "./icons.js";
export type { IconName, IconProps } from "./icons.js";

/* primitives */
export { Button } from "./primitives/Button.js";
export type { ButtonProps, ButtonVariant } from "./primitives/Button.js";
export { Kbd } from "./primitives/Kbd.js";
export type { KbdProps } from "./primitives/Kbd.js";
export { SplitButton } from "./primitives/SplitButton.js";
export type { SplitButtonProps } from "./primitives/SplitButton.js";
export { Chip, Badge, TagDot, TAG_HUES } from "./primitives/Chip.js";
export type {
  ChipProps,
  ChipVariant,
  ChipAction,
  BadgeProps,
  BadgeVariant,
  TagDotProps,
  TagHueName,
} from "./primitives/Chip.js";
export { Avatar } from "./primitives/Avatar.js";
export type { AvatarProps } from "./primitives/Avatar.js";
export { SegmentedControl } from "./primitives/SegmentedControl.js";
export type { SegmentedControlProps, SegmentOption } from "./primitives/SegmentedControl.js";
export { Switch } from "./primitives/Switch.js";
export type { SwitchProps } from "./primitives/Switch.js";
export { ToastHost, useToast } from "./primitives/Toast.js";
export type { ToastHostProps, ToastOptions, ToastFn } from "./primitives/Toast.js";
export { Card } from "./primitives/Card.js";
export type { CardProps, CardLift } from "./primitives/Card.js";
export { Waterline } from "./primitives/Waterline.js";
export type { WaterlineProps } from "./primitives/Waterline.js";
export { InfoNote } from "./primitives/InfoNote.js";
export type { InfoNoteProps } from "./primitives/InfoNote.js";

/* composites */
export { RailNav } from "./composites/RailNav.js";
export type {
  RailNavProps,
  RailGroup,
  RailItem,
  RailTagItem,
  RailMailbox,
} from "./composites/RailNav.js";
export { MessageRow } from "./composites/MessageRow.js";
export type { MessageRowProps, MessageRowTag } from "./composites/MessageRow.js";
export { ListPane, ListGroupLabel, ListRows } from "./composites/ListPane.js";
export type { ListPaneProps } from "./composites/ListPane.js";
export { StreamCard, StreamArt } from "./composites/StreamCard.js";
export type { StreamCardProps, StreamArtProps } from "./composites/StreamCard.js";
export { ReadingPane, ReadColumn } from "./composites/ReadingPane.js";
export type { ReadingPaneProps, ReadingPaneAttachment } from "./composites/ReadingPane.js";
export { Reader } from "./composites/Reader.js";
export type { ReaderProps } from "./composites/Reader.js";
export {
  DecisionBar,
  DECISION_LABEL,
  DECISION_DONE_LABEL,
  DECISION_KEY,
  DECISION_QUIET,
} from "./composites/DecisionBar.js";
export type {
  DecisionBarProps,
  DecisionDestination,
  DecisionScope,
} from "./composites/DecisionBar.js";
export { Doorbell } from "./composites/Doorbell.js";
export type { DoorbellProps } from "./composites/Doorbell.js";
export { CommandPalette } from "./composites/CommandPalette.js";
export type { CommandPaletteProps, Command } from "./composites/CommandPalette.js";
export { ProtectedBlock } from "./composites/ProtectedBlock.js";
export type { ProtectedBlockProps } from "./composites/ProtectedBlock.js";
export { SearchBox, Facets, SearchHit } from "./composites/SearchBox.js";
export type {
  SearchBoxProps,
  FacetsProps,
  FacetGroup,
  SearchHitProps,
} from "./composites/SearchBox.js";
export {
  SettingsSection,
  SettingsSubhead,
  SettingsRow,
  SettingsNote,
  VipChip,
} from "./composites/Settings.js";
export type {
  SettingsSectionProps,
  SettingsSubheadProps,
  SettingsRowProps,
  SettingsNoteProps,
  VipChipProps,
} from "./composites/Settings.js";
export { PilesStack } from "./composites/PilesStack.js";
export type { PilesStackProps, Pile, PileItem } from "./composites/PilesStack.js";
export { FocusReplyOverlay } from "./composites/FocusReplyOverlay.js";
export type {
  FocusReplyOverlayProps,
  FocusReplyMessage,
} from "./composites/FocusReplyOverlay.js";

/* hooks */
export { useSeenOnScroll } from "./hooks/useSeenOnScroll.js";
export type { UseSeenOnScrollOptions, SeenObserver } from "./hooks/useSeenOnScroll.js";
export { useCommandPalette } from "./hooks/useCommandPalette.js";
export type { CommandPaletteState } from "./hooks/useCommandPalette.js";
