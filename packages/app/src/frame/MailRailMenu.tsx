import { useState, type ReactNode } from "react";
import { usePull } from "@ohmail/app-logic/session/pull-new-mail";
import { RailEntry, RailFoot } from "@ohmail/ui/mail";
import { useFramePull } from "./rail-pull.js";
import { MailRowMenu, type MenuTarget } from "./ContextMenu.js";
import { useText } from "../text/index.js";
import type { RailFootModel } from "./contract.js";

export function usePlaceContextMenu() {
  const [target, setTarget] = useState<(MenuTarget & { name: string; open: () => void }) | null>(null);
  const t = useText("ohbox");
  const fed = useFramePull();
  const ground = usePull();
  const pull = fed ?? (ground ? { label: t("list.pull"), busy: ground.pulling, onPress: ground.pull } : null);
  return {
    show: (name: string, open: () => void) => (at: MenuTarget["at"], anchor: HTMLElement) =>
      setTarget({ at, anchor, name, open }),
    menu: target && (
      <MailRowMenu
        target={target}
        label={target.name}
        onClose={() => setTarget(null)}
        items={[
          { label: t("row.open"), icon: "mail", onPress: target.open },
          ...(pull
            ? [{ label: pull.label, icon: "pull" as const, disabled: pull.busy, onPress: pull.onPress }]
            : []),
        ]}
      />
    ),
  };
}

export function MailPlaceButton({ name, ...props }: Parameters<typeof RailEntry>[0] & { name: string }) {
  const menu = usePlaceContextMenu();
  return (
    <>
      <RailEntry {...props} onMenu={props.onPress ? menu.show(name, props.onPress) : undefined} />
      {menu.menu}
    </>
  );
}

/** The rail built by the mail frame can also have a foot without an account. */
export function MailRailFoot({ fed, notice }: { fed: RailFootModel | null; notice: ReactNode }) {
  const pull = fed?.pull
    ? {
        label: fed.pull.label,
        keyHint: fed.pull.keyHint,
        busy: fed.pull.busy,
        onPress: fed.pull.onPress,
      }
    : undefined;
  /* The kit's foot always draws an account line; where nobody is known the frame draws the notice and Pull alone. */
  const accountMenu = usePlaceContextMenu();
  return fed?.account ? (
    <>
      <RailFoot
        notice={notice}
        pull={pull}
        account={{ ...fed.account, onMenu: accountMenu.show(fed.account.title, fed.account.onPress) }}
        tools={fed.tools}
      />
      {accountMenu.menu}
    </>
  ) : (
    <div className="fr-railfoot">
      {notice}
      {pull ? (
        <RailEntry
          kind="tool"
          icon="pull"
          keyHint={pull.keyHint}
          busy={pull.busy}
          title={pull.label}
          onPress={pull.onPress}
        >
          {pull.label}
        </RailEntry>
      ) : null}
    </div>
  );
}
