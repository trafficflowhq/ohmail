/**
 * The mail parts of the kit: the shell, the lists, the reading column, the editor's frame.
 * They draw from plain data and know no engine.
 */
import "../base/index.js";

export { AddressText, type AddressTextProps } from "./AddressText.js";

export { ColumnHandle } from "./Shell/ColumnHandle.js";
export type { ColumnHandleProps } from "./Shell/ColumnHandle.js";
export { Dock } from "./Shell/Dock.js";
export type { DockPlace, DockProps } from "./Shell/Dock.js";
export { Rail } from "./Shell/Rail.js";
export type { RailProps } from "./Shell/Rail.js";
export { RailEntry } from "./Shell/RailEntry.js";
export type { RailEntryProps } from "./Shell/RailEntry.js";
export { RailField } from "./Shell/RailField.js";
export type { RailFieldProps } from "./Shell/RailField.js";
export { RailFoot } from "./Shell/RailFoot.js";
export type { RailFootProps, RailFootTool } from "./Shell/RailFoot.js";
export { readingScroller, Sheet } from "./Shell/Sheet.js";
export type { SheetProps } from "./Shell/Sheet.js";
export { Switcher } from "./Shell/Switcher.js";
export type { SwitcherProduct, SwitcherProps, SwitcherSide } from "./Shell/Switcher.js";

export { Doorbell } from "./Lists/Doorbell.js";
export type { DoorbellProps } from "./Lists/Doorbell.js";
export { GroupHeading } from "./Lists/GroupHeading.js";
export type { GroupHeadingProps } from "./Lists/GroupHeading.js";
export { ListHead } from "./Lists/ListHead.js";
export type { ListHeadProps, Way, WayPart } from "./Lists/ListHead.js";
export { Row, Rows } from "./Lists/Row.js";
export type {
  RowListing,
  RowMark,
  RowPerson,
  RowPlace,
  RowProps,
  RowSwipe,
  RowSwipeVerb,
  RowTick,
} from "./Lists/Row.js";
export { TickList } from "./Lists/TickList.js";
export type { TickListProps, TickPerson } from "./Lists/TickList.js";
export { PullMark } from "./Lists/PullMark.js";
export type { PullMarkProps } from "./Lists/PullMark.js";
export { ListTail } from "./Lists/ListTail.js";
export type { ListTailProps } from "./Lists/ListTail.js";
export { ListLine } from "./Lists/ListLine.js";
export type { ListLineProps } from "./Lists/ListLine.js";
export { MonthRail } from "./Lists/MonthRail.js";
export type { MonthRailEntry, MonthRailProps } from "./Lists/MonthRail.js";
export { ReadSquares } from "./Lists/ReadSquares.js";
export type { ReadSquaresProps, SquareKind, SquaresRun } from "./Lists/ReadSquares.js";
export type { CircleSelection } from "./Lists/SelectionCircle.js";
export { SelectionBar } from "./Lists/SelectionBar.js";
export type { SelectionBarProps } from "./Lists/SelectionBar.js";

export { ActionPanel } from "./Reading/ActionPanel.js";
export type { ActionPanelProps, PanelNote, PanelVerb } from "./Reading/ActionPanel.js";
export { BlankColumn } from "./Reading/BlankColumn.js";
export type { BlankColumnProps } from "./Reading/BlankColumn.js";
export { Files, FileTile } from "./Reading/FileTile.js";
export type { FilesProps, FileTileProps } from "./Reading/FileTile.js";
export { Message } from "./Reading/Message.js";
export type { MessageClip, MessageProps } from "./Reading/Message.js";
export { MessageHead } from "./Reading/MessageHead.js";
export type { HeadLine, HeadPerson, MessageHeadProps } from "./Reading/MessageHead.js";
export { ReadingHead, ReadingLine } from "./Reading/ReadingHead.js";
export type { ReadingHeadProps, ReadingLineProps } from "./Reading/ReadingHead.js";
export { BlockedImages } from "./Reading/BlockedImages.js";
export type { BlockedImagesProps } from "./Reading/BlockedImages.js";
export { DesignedLetter, LETTER_SANDBOX } from "./Reading/DesignedLetter.js";
export type { DesignedLetterProps, LetterLink } from "./Reading/DesignedLetter.js";
export { FileNotArrived } from "./Reading/FileNotArrived.js";
export type { FileNotArrivedProps } from "./Reading/FileNotArrived.js";
export { LetterColumns } from "./Reading/LetterColumns.js";
export type { LetterColumnsProps } from "./Reading/LetterColumns.js";
export { LetterHistory } from "./Reading/LetterHistory.js";
export type { LetterHistoryProps } from "./Reading/LetterHistory.js";
export { LetterQuote } from "./Reading/LetterQuote.js";
export type { LetterQuoteProps } from "./Reading/LetterQuote.js";
export { LetterViews } from "./Reading/LetterViews.js";
export type { LetterView, LetterViewsProps } from "./Reading/LetterViews.js";
export { TextNotKept } from "./Reading/TextNotKept.js";
export type { TextNotKeptProps } from "./Reading/TextNotKept.js";
export { ContactCard, ContactCardHeader, ContactDestinations } from "./Reading/ContactCard.js";
export type { ContactCardProps } from "./Reading/ContactCard.js";
export { QuickLook } from "./Reading/QuickLook.js";
export type { QuickLookProps } from "./Reading/QuickLook.js";
export { MovePicker } from "./Lists/MovePicker.js";
export type { MovePickerProps } from "./Lists/MovePicker.js";
export { FolderFold } from "./Lists/FolderFold.js";
export type { FolderFoldProps, FoldFolder } from "./Lists/FolderFold.js";
export { FolderShelf } from "./Lists/FolderShelf.js";
export type { FolderShelfProps, ShelfFolder } from "./Lists/FolderShelf.js";
export { AccountRow } from "./Lists/AccountRow.js";
export type { AccountRowProps } from "./Lists/AccountRow.js";

export { Attach } from "./Editor/Attach.js";
export type { AttachProps } from "./Editor/Attach.js";
export { AttachRoom } from "./Editor/AttachRoom.js";
export type { AttachRoomProps } from "./Editor/AttachRoom.js";
export { useAfterComposerTextTarget } from "./Editor/AfterComposerText.js";
export { Composer } from "./Editor/Composer.js";
export type { ComposerProps } from "./Editor/Composer.js";
export { ComposerMarks, type ComposerMark, type ComposerMarksProps } from "./Editor/ComposerMarks.js";
export { letterText } from "./Editor/letter-text.js";
export type { LetterTextName } from "./Editor/letter-text.js";
export { DraftControl } from "./Editor/DraftControl.js";
export type { DraftControlProps } from "./Editor/DraftControl.js";
export { DraftTabs } from "./Editor/DraftTabs.js";
export type { DraftTabsProps } from "./Editor/DraftTabs.js";
export { Recipients } from "./Editor/Recipients.js";
export type { RecipientLine, RecipientsProps } from "./Editor/Recipients.js";
export type { RecipientPerson } from "./Editor/RecipientChip.js";
export type { RecipientSuggest, RecipientSuggestion } from "./Editor/recipient-type.js";
export type { Landing } from "./Editor/recipient-drag.js";
export { SendStatus } from "./Editor/SendStatus.js";
export type { SendStatusProps } from "./Editor/SendStatus.js";

export { SettingArea } from "./Settings/SettingArea.js";
export type { SettingAreaProps } from "./Settings/SettingArea.js";
export { LookPicture } from "./Settings/LookPicture.js";
export type { LookFace, LookPictureProps, LookPictureRow, LookScheme } from "./Settings/LookPicture.js";
export { RuleLine } from "./Settings/RuleLine.js";
export type { RuleLineProps } from "./Settings/RuleLine.js";
export { SettingFilter } from "./Settings/SettingFilter.js";
export type { SettingFilterProps } from "./Settings/SettingFilter.js";
export { SettingLine, SettingTable } from "./Settings/SettingLine.js";
export type { SettingLineProps } from "./Settings/SettingLine.js";
export { FigureLine } from "./Settings/FigureLine.js";
export type { FigureLineProps } from "./Settings/FigureLine.js";
export { FigureTable } from "./Settings/FigureTable.js";
export type { FigureRow, FigureTableProps } from "./Settings/FigureTable.js";
export { ScaleBar } from "./Settings/ScaleBar.js";
export type { ScaleBarPart, ScaleBarProps } from "./Settings/ScaleBar.js";
export { SettingActs } from "./Settings/SettingActs.js";
export type { SettingActsProps } from "./Settings/SettingActs.js";
export { SettingNote } from "./Settings/SettingNote.js";
export type { SettingNotePart, SettingNoteProps } from "./Settings/SettingNote.js";
export { SettingTile, SettingTiles } from "./Settings/SettingTiles.js";
export type { SettingTileProps, SettingTilesProps } from "./Settings/SettingTiles.js";
export { SettingsHead } from "./Settings/SettingsHead.js";
export type { SettingsHeadProps } from "./Settings/SettingsHead.js";
export { SettingsSheet } from "./Settings/SettingsSheet.js";
export type { SettingsSheetProps } from "./Settings/SettingsSheet.js";
export { TagLine } from "./Settings/TagLine.js";
export type { TagLineField, TagLineProps } from "./Settings/TagLine.js";
