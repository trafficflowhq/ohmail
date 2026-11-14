/**
 * THE QUALITY PICTURES GO AT, as a sentence with its word: a press opens the four levels, the one taken checked. A
 * move applies to the next pick and to the pictures already on the letter (from their picked bytes).
 */
import { useRef, useState } from "react";
import { Menu, MenuItem, Slot } from "@ohmail/ui/base";
import { IMAGE_QUALITY_LEVELS, type ImageQualityLevel } from "@ohmail/app-logic/write/files";
import { useText, type Text } from "../../text/index.js";

export function levelWord(t: Text, level: ImageQualityLevel): string {
  switch (level) {
    case "low":
      return t("files.level.low");
    case "medium":
      return t("files.level.medium");
    case "high":
      return t("files.level.high");
    case "original":
      return t("files.level.original");
  }
}

export function Quality({
  level,
  locked,
  onLevel,
}: {
  level: ImageQualityLevel;
  locked: boolean;
  onLevel: (level: ImageQualityLevel) => void;
}) {
  const t = useText("write");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const word = levelWord(t, level);
  return (
    <>
      {t.rich("files.quality", {
        word,
        level: () => (
          <Slot
            ref={anchor}
            label={t("files.qualityLabel")}
            expanded={open}
            /* While the letter is held (on its way), the quality is held with it and says so: a word that cannot be
               pressed now, never a live-looking button that does nothing. */
            disabled={locked}
            onPress={locked ? undefined : () => setOpen(true)}
          >
            {word}
          </Slot>
        ),
      })}
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label={t("files.qualityLabel")}>
        {IMAGE_QUALITY_LEVELS.map((l) => (
          <MenuItem
            key={l}
            checked={l === level}
            onPress={() => {
              setOpen(false);
              if (l !== level) onLevel(l);
            }}
          >
            {levelWord(t, l)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
