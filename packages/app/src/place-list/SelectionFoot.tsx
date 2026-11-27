import { useRef, useState, type ReactNode } from "react";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { SelectionBar, type PanelVerb } from "@ohmail/ui/mail";
import { useSelectionBar } from "../frame/commands.js";
import { useText } from "../text/index.js";
import { useForwardSelection } from "./use-forward-selection.js";
import type { RowSelection } from "./use-row-selection.js";
import "./place-list.css";

interface SelectionFootProps {
  selection: RowSelection;
  verbs: PanelVerb[];
  children?: ReactNode;
}

export function SelectionFoot(props: SelectionFootProps) {
  const count = props.selection.pickedRows.length;
  return (
    <>
      <SelectionStatus count={count} />
      {count > 0 ? <PickedFoot {...props} /> : null}
    </>
  );
}

export function SelectionStatus({ count }: { count: number }) {
  const t = useText("ohbox");
  return (
    <span className="oh-vh" aria-live="polite" aria-atomic="true">
      {count > 0 ? t("picked", { count }) : ""}
    </span>
  );
}

export function PickedFoot({ selection, verbs: otherVerbs, children }: SelectionFootProps) {
  const t = useText("ohbox");
  const { pickedRows, clear } = selection;
  const [more, setMore] = useState(false);
  const [folded, setFolded] = useState<readonly string[]>([]);
  const foot = useRef<HTMLDivElement>(null);
  const count = pickedRows.length;
  const forward = useForwardSelection(selection.ids, clear);
  const verbs = forward ? [forward, ...otherVerbs] : otherVerbs;
  useSelectionBar(true);
  return (
    <div ref={foot} className="pl-selection-foot" tabIndex={-1}>
      <SelectionBar
        label={t("bar.label")}
        announceCount={false}
        count={{
          count: String(count),
          word: t("pickedWord"),
          label: t("pickedAria", { count }),
          onClear: clear,
        }}
        verbs={verbs}
        onFold={setFolded}
        more={{
          label: t("actionMore"),
          behind: false,
          expanded: more,
          onPress: () => setMore((was) => !was),
        }}
      />
      <Menu open={more} onClose={() => setMore(false)} anchor={foot} up right label={t("actionMore")}>
        {verbs
          .filter(({ id }) => folded.includes(id))
          .map((verb) => (
            <MenuItem
              key={verb.id}
              icon={verb.icon}
              disabled={verb.disabled}
              description={verb.disabledHint}
              onPress={() => {
                setMore(false);
                if (foot.current) verb.onPress?.(foot.current);
              }}
            >
              {verb.label}
            </MenuItem>
          ))}
      </Menu>
      {children}
    </div>
  );
}
