import { useState } from "react";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import { ShowAsMenu } from "./ShowAsMenu.js";
import { ZoneMenu } from "./ZoneMenu.js";
import type { EventDraft } from "./event-draft.js";

export function EditorActionBar({
  items,
  close,
  duplicate,
  blocked,
  ordinaryOnly,
  timeZone,
  draft,
  change,
}: {
  items: readonly PanelVerb[];
  close: () => void;
  duplicate: () => void;
  blocked: boolean;
  ordinaryOnly?: boolean;
  timeZone?: string;
  draft: EventDraft;
  change: (edit: Partial<EventDraft>) => void;
}) {
  const t = useText("calendar");
  const [popup, show] = useState<{ anchor: HTMLElement; kind: "more" | "zone" | "busy" } | null>(null);
  const more = popup?.kind === "more" ? popup.anchor : null;
  const [folded, fold] = useState<readonly string[]>([]);
  const verbs: PanelVerb[] = [
    { id: "close", label: t("closeEvent"), name: t("edit.closeEditor"), icon: "x", rank: 0, onPress: close },
    { id: "duplicate", label: t("edit.duplicate"), icon: "copy", rank: 3, onPress: duplicate },
    ...items.map((item) => ({ ...item, rank: 2 })),
  ];
  const hide = () => show(null);
  return (
    <>
      <ActionPanel
        label={t("actions.panel")}
        items={verbs.map((verb) => ({
          ...verb,
          disabled: blocked || verb.disabled,
        }))}
        onFold={fold}
        folded={folded}
        more={{
          label: t("more"),
          behind: true,
          expanded: more !== null,
          onPress: (anchor) => {
            if (!blocked) show({ anchor, kind: "more" });
          },
        }}
      />
      {popup?.kind === "zone" && timeZone && !blocked && (
        <ZoneMenu anchor={popup.anchor} zone={timeZone} close={hide} pick={(zone) => change({ zone })} />
      )}
      {popup?.kind === "busy" && !blocked && (
        <ShowAsMenu
          anchor={popup.anchor}
          busy={draft.busy}
          choose={(busy) => change({ busy })}
          close={hide}
        />
      )}
      {more && !blocked && (
        <Menu open anchor={more} label={t("more")} onClose={hide}>
          {verbs
            .filter((verb) => folded.includes(verb.id))
            .map((verb) => (
              <MenuItem
                key={verb.id}
                disabled={verb.disabled}
                onPress={() => {
                  hide();
                  verb.onPress?.(more);
                }}
              >
                {verb.label}
              </MenuItem>
            ))}
          {timeZone && (
            <MenuItem onPress={() => show({ anchor: more, kind: "zone" })}>{t("create.timeZone")}</MenuItem>
          )}
          {!ordinaryOnly && (
            <>
              <MenuItem onPress={() => show({ anchor: more, kind: "busy" })}>{t("create.showAs")}</MenuItem>
              <MenuItem
                checked={draft.private}
                onPress={() => {
                  change({ private: !draft.private });
                  hide();
                }}
              >
                {t("create.private")}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </>
  );
}
