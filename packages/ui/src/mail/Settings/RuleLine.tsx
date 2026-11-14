import { Fragment, type MouseEvent, type ReactNode } from "react";
import { Avatar } from "../../base/index.js";
import "./rule-line.css";

export interface RuleLineProps {
  /** Whose mail the rule files: a sender's address, or a whole domain, as it is written. */
  who: string;
  /**
   * A sender: their circle leads the line and opens their contact card. Left out, the rule is a whole domain's
   * and its circle carries the at sign.
   */
  person?: { name: string; address: string; label: string; onContact: (anchor: HTMLElement) => void };
  /** The rest of the rule's sentence after `who`, the place as a slot in it: "goes to [Ohbox]". */
  goes: ReactNode;
  /** Where the rule came from, under its sentence: "Screener decision · 14 messages". */
  origin?: string;
  /** The one word that acts on the rule, at the line's end: Revoke. */
  act?: ReactNode;
}

/** A sender or domain may break after these, so an address wraps where a person reads a break. */
const BREAKS = /([@.-])/;

/** A rule, said as its sentence: who, where their mail goes, where the rule came from, and the word that ends it. */
export function RuleLine({ who, person, goes, origin, act }: RuleLineProps) {
  const contact = person
    ? (event: MouseEvent<HTMLButtonElement>) => person.onContact(event.currentTarget)
    : undefined;
  return (
    <div className="oh-ruleline">
      {person ? (
        <button
          type="button"
          className="oh-control oh-ruleline-who"
          aria-label={person.label}
          title={person.label}
          onClick={contact}
        >
          <Avatar name={person.name} address={person.address} size="s" />
        </button>
      ) : (
        <Avatar name="@" address={`@${who}`} size="s" />
      )}
      <p className="oh-text oh-ruleline-sentence">
        <b className="oh-ruleline-name">
          {who.split(BREAKS).map((part, i) => (
            <Fragment key={i}>
              {part}
              {BREAKS.test(part) ? <wbr /> : null}
            </Fragment>
          ))}
        </b>{" "}
        <span className="oh-ruleline-goes">{goes}</span>
        {origin ? <small className="oh-ruleline-origin">{origin}</small> : null}
      </p>
      {act ? <span className="oh-ruleline-act">{act}</span> : null}
    </div>
  );
}
