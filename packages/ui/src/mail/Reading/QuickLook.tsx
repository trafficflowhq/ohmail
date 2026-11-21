import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Button, KeyHint, Overlay } from "../../base/index.js";
import type { IconName } from "../../icons/Icon.js";
import "./quick-look.css";

interface Way {
  label: string;
  onPress?: () => void;
}

export interface QuickLookProps {
  open: boolean;
  onClose: () => void;
  /** Its name, said to a screen reader. */
  label: string;
  /** The file's name, and its facts in one line: kind, size, page, which of how many. */
  name: string;
  facts: string;
  kind?: "image" | "pdf" | "text" | "other";
  download?: Way & { busy?: boolean };
  /** Every file of the letter at once. */
  all?: Way & { busy?: boolean };
  close: { label: string };
  /** The file before and the file after. A side with no file has no arrow. */
  prev?: Way;
  next?: Way;
  /** The page before and the page after, where the file has pages. `end`: there is none that way. */
  pages?: { up: Way & { end?: boolean }; down: Way & { end?: boolean } };
  /** The keys at its foot: what each does, and the keys that do it. */
  hints?: readonly { label: string; keys: readonly string[] }[];
  /** The look itself: the picture, the page, the text. */
  children: ReactNode;
}

const round = (side: "prev" | "next", way: Way, icon: IconName) => (
  <span className="oh-quicklook-nav" data-side={side}>
    <Button kind="two" icon={icon} label={way.label} onPress={way.onPress} />
  </span>
);

/** Looking at a file, over the whole view. One Quick Look everywhere a file stands. */
export function QuickLook(props: QuickLookProps) {
  const { open, onClose, label, kind, prev, next, pages, hints, children } = props;
  const keys = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const run =
      event.key === " "
        ? (event.target as HTMLElement).closest("button")
          ? undefined
          : onClose
        : event.key === "ArrowLeft"
          ? prev?.onPress
          : event.key === "ArrowRight"
            ? next?.onPress
            : event.key === "ArrowUp"
              ? pages?.up.end
                ? undefined
                : pages?.up.onPress
              : event.key === "ArrowDown"
                ? pages?.down.end
                  ? undefined
                  : pages?.down.onPress
                : undefined;
    if (!run) return false;
    event.preventDefault();
    run();
    return true;
  };
  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={label}
      className="oh-quicklook"
      scrimMotion="backdrop"
      first={(box) => box}
      onKey={keys}
    >
      {quickLookHead(props)}
      <div className="oh-quicklook-stage">
        {prev ? round("prev", prev, "back") : null}
        <div className="oh-quicklook-look" data-kind={kind}>
          {children}
        </div>
        {next ? round("next", next, "back") : null}
      </div>
      {hints?.length ? (
        <footer className="oh-quicklook-foot">
          {hints.map((hint) => (
            <span key={hint.label} className="oh-quicklook-hint">
              {hint.keys.map((key) => (
                <KeyHint key={key} shown>
                  {key}
                </KeyHint>
              ))}
              {hint.label}
            </span>
          ))}
        </footer>
      ) : null}
    </Overlay>
  );
}

function quickLookHead({ name, facts, pages, all, download, close, onClose }: QuickLookProps) {
  return (
    <header className="oh-quicklook-head">
      <div className="oh-quicklook-id">
        <b className="oh-quicklook-name">{name}</b>
        <span className="oh-quicklook-facts">{facts}</span>
      </div>
      <div className="oh-quicklook-tools">
        {pages ? (
          <span className="oh-quicklook-pager">
            <span data-turned="">
              <Button
                kind="quiet"
                size="s"
                icon="down"
                label={pages.up.label}
                disabled={pages.up.end}
                onPress={pages.up.onPress}
              />
            </span>
            <Button
              kind="quiet"
              size="s"
              icon="down"
              label={pages.down.label}
              disabled={pages.down.end}
              onPress={pages.down.onPress}
            />
          </span>
        ) : null}
        {all ? (
          <span className="oh-quicklook-all" aria-busy={all.busy || undefined}>
            <Button kind="quiet" size="s" busy={all.busy} onPress={all.onPress}>
              {all.label}
            </Button>
          </span>
        ) : null}
        {download ? (
          <span className="oh-quicklook-save">
            <Button
              kind="two"
              size="s"
              icon="download"
              label={download.label}
              busy={download.busy}
              onPress={download.onPress}
            >
              {download.label}
            </Button>
          </span>
        ) : null}
        <Button kind="quiet" size="s" icon="x" label={close.label} onPress={onClose} />
      </div>
    </header>
  );
}

/** File previews stand over the entire window and take paste and drop away from the composer. */
export function FileQuickLook(props: QuickLookProps) {
  const keepHere = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return createPortal(
    <div onPaste={keepHere} onDragOver={keepHere} onDrop={keepHere}>
      <QuickLook {...props} />
    </div>,
    document.body,
  );
}
