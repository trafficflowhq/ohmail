import type { ReactNode } from "react";
import "./setting-acts.css";

export interface SettingActsProps {
  /** What the acts are about, said to a screen reader: the sheet's name. */
  label?: string;
  /** The sheet's own acts: at most one ink button, then second buttons and words that act. */
  children: ReactNode;
}

/** A sheet's own row of acts, under its lines. Short of room they go one under the other. */
export function SettingActs({ label, children }: SettingActsProps) {
  return (
    <div className="oh-settingacts" role="group" aria-label={label}>
      {children}
    </div>
  );
}
