import { useRef, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import { Tag, Where } from "../../base/index.js";
import { useMeasuredMark } from "../../base/measured-mark.js";
import { Icon } from "../../icons/Icon.js";
import type { RowProps } from "./Row.js";
import { RowAmount } from "./row-tick.js";

/** A standing button can wrap when its full width would displace the name or a label. */
function MeasuredFirst(props: ComponentPropsWithoutRef<"span">) {
  const line = useRef<HTMLSpanElement>(null);
  useMeasuredMark(line, line, "foldVerb", true);
  return <span {...props} ref={line} />;
}

/** Line one: who, the address, and at its end the marks and the time. */
export function RowFirst(
  props: RowProps & { contact?: (event: MouseEvent<HTMLElement>) => void; twin?: boolean },
) {
  const { who, address, contact, onWhen } = props;
  const Line = props.own && props.labels?.length && !props.twin ? MeasuredFirst : "span";
  const flip = onWhen
    ? (event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        onWhen();
      }
    : undefined;
  return (
    <Line className="oh-row-first" aria-hidden={props.twin ? true : undefined}>
      <b className="oh-row-who">{who}</b>
      {props.flag ? (
        <span className="oh-row-flag">
          <span className="oh-row-flag-sign" role="img" aria-label={props.flag.label}>
            <Icon name="warn" size={18} />
          </span>
          <Tag>{props.flag.word}</Tag>
        </span>
      ) : address ? (
        <span
          className="oh-row-address"
          data-press={contact ? "" : undefined}
          data-whole={props.labels?.length ? "" : undefined}
          onClick={contact}
        >
          {props.labels?.length ? <span>{address}</span> : address}
        </span>
      ) : null}
      <span className="oh-row-room" />
      {props.labels && props.labels.length > 0 ? (
        <span className="oh-row-labels">
          {props.labels.map((label) => (
            <Tag key={label}>{label}</Tag>
          ))}
        </span>
      ) : null}
      {props.squares}
      {props.where ? <Where>{props.where}</Where> : null}
      {props.tag}
      {props.file ? (
        <span className="oh-row-file" role="img" aria-label={props.file}>
          <Icon name="clip" size={16} />
        </span>
      ) : null}
      {props.amount ? (
        <RowAmount figure={props.amount} said={props.amountSaid} />
      ) : props.when ? (
        <time
          className="oh-row-when"
          title={props.whenTitle}
          data-press={onWhen ? "" : undefined}
          onClick={flip}
        >
          {props.when}
        </time>
      ) : null}
    </Line>
  );
}
