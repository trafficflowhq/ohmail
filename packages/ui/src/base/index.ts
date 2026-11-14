/**
 * The base of the kit: the primitives, the overlays, what reports and what stands empty, the icons
 * and the motion helper. Every part draws from its inputs and the design's values, and knows no
 * engine, no catalogue and no host. The words a part shows are handed to it.
 */
import "@ohmail/tokens/design.css";
import "@ohmail/tokens/design/motion.css";
import "@ohmail/tokens/design/fonts.css";
import "./base.css";

export { Icon, icons, ICON_SIZES } from "../icons/Icon.js";
export type { IconName, IconProps, IconSize } from "../icons/Icon.js";
export {
  animate,
  flipPlay,
  flipSnap,
  motionEase,
  motionMs,
  motionReduced,
  motionShape,
} from "../motion/motion.js";
export type { AnimateOptions, DurationToken, EaseToken, ShapeToken } from "../motion/motion.js";
/* The size of a file, said once (`format/file-size.ts`): pure, and the same sentence in every part that names one. */
export { formatFileSize } from "../format/file-size.js";
export { design, v } from "./tokens.js";
export type { MotionRole, TokenName } from "./tokens.js";

export { Button } from "./Primitives/Button.js";
export type { ButtonProps } from "./Primitives/Button.js";
export { Dot } from "./Primitives/Dot.js";
export type { DotProps } from "./Primitives/Dot.js";
export { EndDot } from "./Primitives/EndDot.js";
export type { EndDotProps } from "./Primitives/EndDot.js";
export { Mark } from "./Primitives/Mark.js";
export type { MarkProps } from "./Primitives/Mark.js";
export { KeyHint } from "./Primitives/KeyHint.js";
export type { KeyHintProps } from "./Primitives/KeyHint.js";
export { Slot } from "./Primitives/Slot.js";
export type { SlotProps } from "./Primitives/Slot.js";
export { Sentence, SentencePart } from "./Primitives/Sentence.js";
export type { SentencePartProps, SentenceProps } from "./Primitives/Sentence.js";
export { Blank } from "./Primitives/Blank.js";
export type { BlankProps } from "./Primitives/Blank.js";
export { Field } from "./Primitives/Field.js";
export type { FieldProps } from "./Primitives/Field.js";
export { FieldPair, FieldStack } from "./Primitives/FieldStack.js";
export type { FieldPairProps, FieldStackProps } from "./Primitives/FieldStack.js";
export { FindField } from "./Primitives/FindField.js";
export type { FindFieldProps } from "./Primitives/FindField.js";
export { ChoiceTiles } from "./Primitives/ChoiceTiles.js";
export type { ChoiceTile, ChoiceTilesProps } from "./Primitives/ChoiceTiles.js";
export { Switch } from "./Primitives/Switch.js";
export type { SwitchProps } from "./Primitives/Switch.js";
export { Seg } from "./Primitives/Seg.js";
export type { SegOption, SegProps } from "./Primitives/Seg.js";
export { RadioLines } from "./Primitives/RadioLines.js";
export type { RadioLine, RadioLinesProps } from "./Primitives/RadioLines.js";
export { Avatar } from "./Primitives/Avatar.js";
export type { AvatarProps, AvatarSize } from "./Primitives/Avatar.js";
export { Faces } from "./Primitives/Faces.js";
export type { FacesProps } from "./Primitives/Faces.js";
export { Sign } from "./Primitives/Sign.js";
export type { SignProps } from "./Primitives/Sign.js";
export { avatarHue, hueStyle } from "./Primitives/hue.js";
export { Tag } from "./Primitives/Tag.js";
export type { TagProps } from "./Primitives/Tag.js";
export { TagDot } from "./Primitives/TagDot.js";
export type { TagDotProps } from "./Primitives/TagDot.js";
export { Where } from "./Primitives/Where.js";
export { Count } from "./Primitives/Count.js";
export type { CountProps } from "./Primitives/Count.js";
export { InfoMark } from "./Primitives/InfoMark.js";
export type { InfoMarkProps } from "./Primitives/InfoMark.js";
export { HintLine } from "./Primitives/HintLine.js";
export type { HintLineProps } from "./Primitives/HintLine.js";
export { JumpBack } from "./Primitives/JumpBack.js";
export type { JumpBackProps } from "./Primitives/JumpBack.js";

export { Menu } from "./Overlays/Menu.js";
export type { MenuProps } from "./Overlays/Menu.js";
export { MenuGroup } from "./Overlays/MenuGroup.js";
export type { MenuGroupProps } from "./Overlays/MenuGroup.js";
export { MenuItem } from "./Overlays/MenuItem.js";
export type { MenuItemProps } from "./Overlays/MenuItem.js";
export { MenuNote } from "./Overlays/MenuNote.js";
export { MenuRule } from "./Overlays/MenuRule.js";
export { GLASS } from "./glass.js";
export { closeTopOverlay } from "./Overlays/overlay-escape.js";
export { Overlay } from "./Overlays/Overlay.js";
export type { OverlayProps } from "./Overlays/Overlay.js";
export { contextTrigger, placeMenu } from "./Overlays/menu-place.js";
export type { Edges, Point, Size } from "./Overlays/menu-place.js";
export { SuggestionCredit, SuggestionList, suggestionId } from "./Overlays/SuggestionList.js";
export type {
  SuggestionCreditProps,
  SuggestionGroup,
  SuggestionListProps,
  SuggestionRow,
  SuggestionVia,
} from "./Overlays/SuggestionList.js";
export { markTyped } from "./Overlays/suggestion-mark.js";
export type { TypedPart } from "./Overlays/suggestion-mark.js";
export { placeSuggestions } from "./Overlays/suggestion-place.js";
export type { FieldPlace } from "./Overlays/suggestion-place.js";
export { suggestionStore, useSuggestions } from "./Overlays/use-suggestions.js";
export type {
  SuggestionField,
  Suggestions,
  SuggestionsOptions,
  SuggestionStore,
} from "./Overlays/use-suggestions.js";
export { Dialog } from "./Overlays/Dialog.js";
export type { DialogProps } from "./Overlays/Dialog.js";
export { PhoneSheet } from "./Overlays/PhoneSheet.js";
export type { PhoneSheetProps } from "./Overlays/PhoneSheet.js";
export { Palette } from "./Overlays/Palette.js";
export type { PaletteCommand, PaletteProps } from "./Overlays/Palette.js";
export { KeyHelp } from "./Overlays/KeyHelp.js";
export type { KeyHelpGroup, KeyHelpProps, KeyHelpRow } from "./Overlays/KeyHelp.js";

export { Notice } from "./Feedback/Notice.js";
export type { NoticeAct, NoticeProps } from "./Feedback/Notice.js";
export { NoticeSlot, slotOrder } from "./Feedback/NoticeSlot.js";
export type { NoticeSlotProps, SlotNotice } from "./Feedback/NoticeSlot.js";
export { Report } from "./Feedback/Report.js";
export type { ReportProps } from "./Feedback/Report.js";
export { Empty } from "./Feedback/Empty.js";
export type { EmptyProps } from "./Feedback/Empty.js";
export { WaitRow } from "./Feedback/WaitRow.js";
export type { WaitRowProps } from "./Feedback/WaitRow.js";
export { RefusalLine } from "./Feedback/RefusalLine.js";
export type { RefusalLineProps } from "./Feedback/RefusalLine.js";

export { Page } from "./Pages/Page.js";
export type { PageLinePart, PageProps } from "./Pages/Page.js";
export { CameraSquare } from "./Pages/CameraSquare.js";
export type { CameraSquareProps } from "./Pages/CameraSquare.js";
export { Counters } from "./Pages/Counters.js";
export type { Counter, CountersProps } from "./Pages/Counters.js";
export { StepDots } from "./Pages/StepDots.js";
export type { StepDotsProps } from "./Pages/StepDots.js";
export { Opening } from "./Pages/Opening.js";
export type { OpeningProps } from "./Pages/Opening.js";
export { RowsShape } from "./Pages/RowsShape.js";
export type { RowsShapeProps } from "./Pages/RowsShape.js";
