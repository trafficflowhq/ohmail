import { useRef, useState } from "react";
import { InfoMark, Menu } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { SCREENER_NAMESPACE } from "./namespace.js";

export function SettingDetails({ title, lines }: { title: string; lines: readonly string[] }) {
  const t = useText(SCREENER_NAMESPACE);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t("details", { title });
  return (
    <>
      <InfoMark ref={anchor} label={label} expanded={open} onPress={() => setOpen(!open)} />
      <Menu
        anchor={anchor}
        kind="card"
        label={label}
        title={title}
        open={open}
        onClose={() => setOpen(false)}
      >
        {lines.map((line) => (
          <SettingNote key={line}>{line}</SettingNote>
        ))}
      </Menu>
    </>
  );
}
