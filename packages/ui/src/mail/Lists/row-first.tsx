import { Fragment, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Tag, Where } from "../../base/index.js";
import { useMeasuredMark } from "../../base/measured-mark.js";
import { cssRect } from "../../base/ui-zoom.js";
import { Icon } from "../../icons/Icon.js";
import { AddressText } from "../AddressText.js";
import type { RowProps } from "./Row.js";
import { RowAmount } from "./row-tick.js";

/** Short stubs leave the line. The address also yields before a personal tag that would be clipped. */
function fitFirstLine(line: HTMLElement, fitAddress: boolean) {
  delete line.dataset.foldAddress;
  delete line.dataset.foldTag;
  const address = line.querySelector<HTMLElement>(":scope > .oh-row-address");
  const room = address?.clientWidth ?? 0;
  const words = address?.scrollWidth ?? 0;
  if (fitAddress && words > room + 1) {
    const floor = Number.parseFloat(getComputedStyle(line).getPropertyValue("--row-byline-fit-floor"));
    if (room < Math.max(floor, words * 0.6)) line.dataset.foldAddress = "";
  }

  const name = line.querySelector<HTMLElement>(":scope > .oh-tag[data-own] > .oh-tag-name");
  if (!name || !name.getClientRects().length) return;

  const text = name.ownerDocument.createRange();
  text.selectNodeContents(name);
  const clipped = () => cssRect(text).width > cssRect(name).width;
  if (!clipped()) return;

  if (words > room) line.dataset.foldAddress = "";
  if (clipped()) line.dataset.foldTag = "";
}

function useFirstLineFit(enabled: boolean, fitAddress: boolean) {
  const line = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (enabled && line.current) fitFirstLine(line.current, fitAddress);
  });
  useLayoutEffect(() => {
    const el = line.current;
    if (!el || !enabled) return;
    const fit = () => fitFirstLine(el, fitAddress);
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    watch?.observe(el);
    const address = el.querySelector(":scope > .oh-row-address");
    if (fitAddress && address) watch?.observe(address);
    document.fonts?.addEventListener("loadingdone", fit);
    return () => {
      watch?.disconnect();
      document.fonts?.removeEventListener("loadingdone", fit);
      delete el.dataset.foldAddress;
      delete el.dataset.foldTag;
    };
  }, [enabled, fitAddress]);
  return line;
}

export interface RowNameAction {
  label: string;
  onPress: (anchor: HTMLButtonElement) => void;
}

const openContact =
  (action: (anchor: HTMLButtonElement) => void) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) return;
    event.stopPropagation();
    action(event.currentTarget);
  };

function rowName(
  text: ReactNode,
  {
    href,
    contact,
    nameAction,
    nameActions,
  }: Pick<RowProps, "nameAction" | "nameActions"> & {
    href?: string;
    contact?: (event: MouseEvent<HTMLElement>) => void;
  },
) {
  const nameButton = (text: ReactNode, action: RowNameAction) => (
    <button
      className="oh-control oh-row-contact-name"
      type="button"
      aria-label={action.label}
      aria-haspopup="dialog"
      onClick={openContact(action.onPress)}
    >
      {text}
    </button>
  );
  if (nameActions?.length)
    return nameActions.map((part, index) => (
      <Fragment key={part.id}>
        {index > 0 ? ", " : null}
        {nameButton(part.text, part)}
      </Fragment>
    ));
  if (nameAction) return nameButton(text, nameAction);
  if (href)
    return (
      <a className="oh-row-contact" href={href} onClick={contact}>
        {text}
      </a>
    );
  return text;
}

/** Line one: who, the address, and at its end the marks and the time. */
export function RowFirst(
  props: RowProps & { contact?: (event: MouseEvent<HTMLElement>) => void; twin?: boolean },
) {
  const { who, address, contact, onWhen, keepAddressDomain } = props;
  const href = props.twin ? undefined : props.contactHref;
  const { nameAction, nameActions, addressAction } = props.twin ? {} : props;
  const addressStyle = {
    className: "oh-row-address",
    "data-press": contact || addressAction ? "" : undefined,
    "data-whole": props.labels?.length && !keepAddressDomain ? "" : undefined,
    "data-domain": keepAddressDomain ? "" : undefined,
    onClick: contact,
  };
  const shownAddress =
    keepAddressDomain && address ? (
      <AddressText address={address} />
    ) : props.labels?.length ? (
      <span>{address}</span>
    ) : (
      address
    );
  const shownWho = keepAddressDomain && !address ? <AddressText address={who} /> : who;
  const fitAddress = Boolean(props.fitAddress && address);
  const line = useFirstLineFit(!keepAddressDomain && (Boolean(props.tag) || fitAddress), fitAddress);
  useMeasuredMark(line, line, "foldVerb", Boolean(props.own && props.labels?.length && !props.twin));
  const flip = onWhen
    ? (event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        onWhen();
      }
    : undefined;
  return (
    <span ref={line} className="oh-row-first" aria-hidden={props.twin ? true : undefined}>
      <b className="oh-row-who" data-domain={keepAddressDomain && !address ? "" : undefined}>
        {rowName(shownWho, { href: address ? undefined : href, contact, nameAction, nameActions })}
      </b>
      {props.senderCheck ? <Tag title={props.senderCheck.title}>{props.senderCheck.label}</Tag> : null}
      {props.flag ? (
        <span className="oh-row-flag">
          <span className="oh-row-flag-sign" role="img" aria-label={props.flag.label}>
            <Icon name="warn" size={18} />
          </span>
          <Tag>{props.flag.word}</Tag>
        </span>
      ) : address ? (
        href ? (
          <a {...addressStyle} className="oh-row-address oh-row-contact" href={href}>
            {shownAddress}
          </a>
        ) : addressAction ? (
          <button
            {...addressStyle}
            className="oh-control oh-row-address"
            type="button"
            aria-label={address}
            aria-haspopup="dialog"
            onClick={openContact(addressAction)}
          >
            {shownAddress}
          </button>
        ) : (
          <span {...addressStyle}>{shownAddress}</span>
        )
      ) : null}
      <span className="oh-row-room" />
      {props.labels && props.labels.length > 0 ? (
        <span className="oh-row-labels">
          {props.labels.map((label) => (
            <Tag key={label}>{label}</Tag>
          ))}
        </span>
      ) : null}
      {props.squaresBelow ? null : props.squares}
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
    </span>
  );
}
