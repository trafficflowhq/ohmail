import { Fragment, type ReactNode } from "react";
import { Avatar, Button, Tag } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import { Sheet } from "../Shell/Sheet.js";
import "./account-row.css";

export interface AccountRowProps {
  /** Who it is, as the row prints it, and the address that picks the circle's hue. */
  name: string;
  address: string;
  /** What is known about it, a fact a piece: "Synced 09:23", "IMAP". */
  facts?: readonly string[];
  /** Its state as one word: Connected, In step. Beside the row with a pointer, before the facts under a finger. */
  state?: string;
  /** Words for what the account carries: Mail, Calendar. */
  carries?: readonly string[];
  /** An offer in place of a state: the row's one action. */
  offer?: { label: string; onPress?: () => void };
  /** Whether its lines stand. */
  expanded: boolean;
  onToggle?: () => void;
  /** Its lines, in place. */
  children?: ReactNode;
}

/** One account in Settings: who it is, what it carries, and its one action. */
export function AccountRow(props: AccountRowProps) {
  const { name, address, facts, state, carries, offer, expanded, onToggle, children } = props;
  return (
    <Sheet kind="plain">
      <div className="oh-accountrow" data-open={expanded ? "" : undefined}>
        <div className="oh-accountrow-head" onClick={onToggle}>
          <button type="button" className="oh-control oh-accountrow-row" aria-expanded={expanded}>
            <Avatar name={name} address={address} />
            <span className="oh-accountrow-who">
              <b className="oh-accountrow-name">{name}</b>
              {facts?.length || state ? (
                <span className="oh-accountrow-facts">
                  {(facts?.length ? facts : [""]).map((fact, i) => (
                    <Fragment key={i}>
                      {i ? <i className="oh-accountrow-between"> · </i> : null}
                      <span className="oh-accountrow-fact">
                        {!i && state ? (
                          <span className="oh-accountrow-state">
                            {state}
                            {fact ? " · " : ""}
                          </span>
                        ) : null}
                        {fact}
                      </span>
                    </Fragment>
                  ))}
                </span>
              ) : null}
            </span>
          </button>
          {offer ? (
            <span className="oh-accountrow-offer" onClick={(event) => event.stopPropagation()}>
              <Button kind="two" size="s" onPress={offer.onPress}>
                {offer.label}
              </Button>
            </span>
          ) : null}
          {carries?.length ? (
            <span className="oh-accountrow-carries">
              {carries.map((word) => (
                <Tag key={word}>{word}</Tag>
              ))}
            </span>
          ) : state ? (
            <span className="oh-accountrow-word">
              <Tag>{state}</Tag>
            </span>
          ) : null}
          <span className="oh-accountrow-chevron" aria-hidden="true">
            <Icon name="down" size={20} />
          </span>
        </div>
        {expanded ? children : null}
      </div>
    </Sheet>
  );
}
