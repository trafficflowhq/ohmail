import { createPortal } from "react-dom";
import { DatePicker as Picker, type DatePickerProps } from "@ohmail/ui/date-picker-view";
import "./date-picker.css";

/** Keep viewport placement outside the animated, scrolling event card. */
export function DatePicker({
  anchor,
  onPick,
  onClose,
  ...props
}: Omit<DatePickerProps, "className" | "anchor"> & { anchor: HTMLElement }) {
  const doc = anchor.ownerDocument;
  const restoreFocus = () => {
    if (doc.activeElement?.closest(".calendar-date-picker")) anchor.focus({ preventScroll: true });
  };
  return createPortal(
    <Picker
      {...props}
      anchor={anchor}
      className="calendar-date-picker"
      onPick={(day) => {
        restoreFocus();
        onPick(day);
      }}
      onClose={() => {
        restoreFocus();
        onClose();
      }}
    />,
    doc.body,
  );
}
