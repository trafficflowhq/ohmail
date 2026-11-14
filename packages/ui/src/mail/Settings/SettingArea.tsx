import { Field } from "../../base/index.js";
import "./setting-area.css";

export interface SettingAreaProps {
  /** What the field asks for, standing over it: "In your words, what belongs in your Ohbox". It names the field. */
  label: string;
  value: string;
  onChange?: (value: string) => void;
  /** How many lines it starts with. */
  lines?: number;
  /** The refusal: one line under the field that names the fix. */
  refusal?: string;
  name?: string;
}

/** A setting written in words: its label over a field of several lines, on a sheet of settings. */
export function SettingArea({ label, value, onChange, lines = 3, refusal, name }: SettingAreaProps) {
  return (
    <div className="oh-settingarea">
      <Field label={label} value={value} onChange={onChange} lines={lines} refusal={refusal} name={name} />
    </div>
  );
}
