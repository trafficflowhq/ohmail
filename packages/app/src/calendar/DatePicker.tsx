import { DatePicker as Picker, type DatePickerProps } from "@ohmail/ui/date-picker-view";
import "./date-picker.css";

/** The current kit’s date field, using the same keyboard and date calculations everywhere. */
export function DatePicker(props: Omit<DatePickerProps, "className">) {
  return <Picker {...props} className="calendar-date-picker" />;
}
