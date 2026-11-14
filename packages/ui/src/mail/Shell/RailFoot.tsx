import type { ReactNode } from "react";
import { Avatar, Button } from "../../base/index.js";
import type { IconName } from "../../icons/Icon.js";
import { RailEntry } from "./RailEntry.js";
import "./rail-foot.css";

/** A quiet icon at the end of the account's line: the command palette, the light and dark switch. */
export interface RailFootTool {
  icon: IconName;
  /** Its name, with its key where it has one: "Command palette · Ctrl K". */
  label: string;
  onPress?: () => void;
}

export interface RailFootProps {
  /** The one notice slot. */
  notice?: ReactNode;
  /** Pull new mail: while it works its arrow turns once. */
  pull?: { label: string; keyHint?: string; keyShown?: boolean; busy?: boolean; onPress?: () => void };
  /** The account: its circle, its name, and one line under it (how many mailboxes). */
  account: {
    name: string;
    /** What the circle's colour comes from. */
    address: string;
    note: string;
    /** The pointer's hint: where a press leads. */
    title: string;
    current?: boolean;
    onPress?: () => void;
  };
  tools?: readonly RailFootTool[];
}

/** The rail's foot: the one notice, Pull new mail, the account with its two quiet tools. */
export function RailFoot({ notice, pull, account, tools }: RailFootProps) {
  return (
    <div className="oh-railfoot">
      {notice}
      {pull ? (
        <div className="oh-railfoot-tools">
          <RailEntry
            kind="tool"
            icon="pull"
            keyHint={pull.keyHint}
            keyShown={pull.keyShown}
            busy={pull.busy}
            title={pull.label}
            onPress={pull.onPress}
          >
            {pull.label}
          </RailEntry>
        </div>
      ) : null}
      <div className="oh-railfoot-line">
        <button
          type="button"
          className="oh-control oh-railfoot-account"
          title={account.title}
          aria-current={account.current ? "page" : undefined}
          onClick={account.onPress}
        >
          <Avatar name={account.name} address={account.address} size="s" />
          <span className="oh-railfoot-who">
            <b className="oh-railfoot-name">{account.name}</b>
            <span className="oh-railfoot-note">{account.note}</span>
          </span>
        </button>
        {tools?.length ? (
          <span className="oh-railfoot-end">
            {tools.map((tool) => (
              <Button
                key={tool.icon}
                kind="quiet"
                size="s"
                icon={tool.icon}
                label={tool.label}
                onPress={tool.onPress}
              />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
