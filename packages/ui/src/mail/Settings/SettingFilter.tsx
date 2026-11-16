import type { ReactNode } from "react";
import "./setting-filter.css";

export interface SettingFilterProps {
  /** The word before the control where it is a slot: "Files into". Left out where the control names itself. */
  label?: string;
  /** What the list is narrowed by: a segmented control, or under a finger a slot. */
  children: ReactNode;
  /** One word that acts on what the filter leaves, at the line's end: "Revoke all 6 matching". */
  act?: ReactNode;
}

/** The line that narrows a list on a sheet of settings: the filter, and at its end the word that acts on what is left. */
export function SettingFilter({ label, children, act }: SettingFilterProps) {
  return (
    <div className="oh-settingfilter" data-act={act ? "" : undefined}>
      {label ? <span className="oh-settingfilter-label">{label}</span> : null}
      {children}
      {act}
    </div>
  );
}
