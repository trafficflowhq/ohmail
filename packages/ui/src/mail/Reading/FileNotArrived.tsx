import { Button, mailContextTrigger, type Point } from "../../base/index.js";
import "./file-not-arrived.css";
import "./file-tile.css";
import { WarnRow } from "./WarnRow.js";

interface Tile {
  /** What it is, as a few letters: "PDF", "MOV". */
  kind: string;
  name: string;
  /** Its state as one whole sentence, where a fetched file has its size. */
  line: string;
}

export type FileNotArrivedProps =
  | (Tile & { state: "fetching" })
  | (Tile & {
      state: "failed";
      onMenu?: (at: Point | Element, opener: HTMLElement) => void;
      /** The way on, where asking again or signing in can help. `full` says it with the file's name. */
      way?: { label: string; full?: string; onPress?: () => void };
    })
  /** Too large to fetch: nothing helps, so the tile carries no button. */
  | (Tile & { state: "large" })
  | {
      /** The list of files itself did not load. */
      state: "list";
      line: string;
      way?: { label: string; busy?: boolean; onPress?: () => void };
    };

/** A file that did not arrive: the tile stays, and its second line says its state. */
export function FileNotArrived(props: FileNotArrivedProps) {
  if (props.state === "list") return <WarnRow way={props.way}>{props.line}</WarnRow>;
  const { state, kind, name, line } = props;
  const inside = (
    <>
      <i className="oh-file-kind">{kind}</i>
      <span className="oh-file-name">
        <b className="oh-file-title">{name}</b>
        <span className="oh-file-size" role={state === "large" ? undefined : "status"}>
          {line}
        </span>
      </span>
    </>
  );
  return (
    <span
      className="oh-file"
      data-state={state}
      {...mailContextTrigger(state === "failed" ? props.onMenu : undefined)}
    >
      {state === "fetching" ? (
        <button type="button" className="oh-control oh-file-main" aria-busy="true">
          {inside}
        </button>
      ) : (
        <span className="oh-file-main">{inside}</span>
      )}
      {props.state === "failed" && props.way ? (
        <span className="oh-file-way">
          <Button kind="two" size="s" label={props.way.full} onPress={props.way.onPress}>
            {props.way.label}
          </Button>
        </span>
      ) : null}
    </span>
  );
}
