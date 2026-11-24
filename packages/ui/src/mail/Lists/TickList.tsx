import { useId } from "react";
import { Button } from "../../base/index.js";
import { Row } from "./Row.js";
import "./tick-list.css";

/** Somebody to tick. */
export interface TickPerson {
  id: string;
  name: string;
  address: string;
  /** How many letters, as printed at the end of the name's line: "12×". */
  count?: string;
  /** The same in words, said in the figure's place: "12 messages". */
  said?: string;
  /** Ticked. */
  on: boolean;
}

export interface TickListProps {
  /** The list's own head: how many there are, and what they are: "7", "people you wrote to". */
  figure: string;
  words: string;
  /** The rows' name, said to a screen reader: "People you wrote to". */
  label: string;
  /** The field that finds one of them: its name is said, its placeholder is shown. */
  find?: { label: string; placeholder: string; value: string; onChange?: (value: string) => void };
  /** One press for all of them or for none: its word says which ("All", "None"). */
  all?: { label: string; onPress?: () => void };
  /** The people, as the field found them. */
  people: readonly TickPerson[];
  onTick?: (id: string) => void;
  /**
   * The ticks were taken: no row takes a press any more, a ticked person ends in the dot, and the field and the
   * press for all are gone.
   */
  settled?: boolean;
}

/**
 * People to tick, on a sheet of their own (`Sheet kind="plain"`): the count as the list's own head, a field to find
 * one, all or none, and each person a row that is a checkbox with its tick at the row's end.
 */
export function TickList(props: TickListProps) {
  const { figure, words, label, find, all, people, onTick, settled } = props;
  const finds = useId();
  return (
    <div className="oh-ticklist">
      <header className="oh-ticklist-head">
        <h2 className="oh-text oh-display oh-ticklist-count">
          <span className="oh-ticklist-figure">{figure}</span> {words}
        </h2>
        {find && !settled ? (
          <span className="oh-ticklist-find">
            <label className="oh-vh oh-ticklist-said" htmlFor={finds}>
              {find.label}
            </label>
            <input
              id={finds}
              className="oh-control oh-ticklist-line"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={find.placeholder}
              value={find.value}
              readOnly={!find.onChange}
              onChange={(event) => find.onChange?.(event.currentTarget.value)}
            />
          </span>
        ) : null}
        {all && !settled ? (
          <Button kind="quiet" size="s" onPress={all.onPress}>
            {all.label}
          </Button>
        ) : null}
      </header>
      <div className="oh-rows" role="group" aria-label={label}>
        {people.map((person) => (
          <Row
            key={person.id}
            who={person.name}
            people={[person]}
            subject=""
            preview={person.address}
            amount={person.count}
            amountSaid={person.said}
            unread={person.on}
            tick={{ on: person.on, settled }}
            onOpen={() => onTick?.(person.id)}
          />
        ))}
      </div>
    </div>
  );
}
