/**
 * A message body on the phone, a page at a time. A 2 MiB plain body handed to one Text froze the
 * app for over a minute when it was shown; past `BODY_PAGE_CHARS` each page is its own Text and
 * "Show more" adds the next. The count keys on the text, so it never carries over to the next
 * message. A clamped caller (`numberOfLines`) draws the first page and offers no press.
 */
import { Fragment, memo, useContext, useMemo, useState } from "react";
import { View } from "react-native";
import { QUOTED_HISTORY_LIMITS, quotedHistoryOfText } from "../mail/quoted-tree";
import { Copy } from "../copy";
import { Txt, type TxtProps } from "./base";
import { bodyPages, pageBlocks, pagesAskedFor } from "./body-pages";
import { FoldContext, HistoryRow, type FoldScope } from "./HistoryFold";

type BodyPagesProps = Omit<TxtProps, "children"> & { text: string };

/** One page, kept across a further press: only the new page is laid out, in its blocks. */
const Page = memo(
  function Page({ text, style, ...rest }: BodyPagesProps) {
    return (
      <View style={style}>
        {pageBlocks(text).map((block, i) => <Txt key={i} {...rest}>{block}</Txt>)}
      </View>
    );
  },
  (a, b) => a.text === b.text && a.variant === b.variant && a.tone === b.tone
    && a.selectable === b.selectable && a.numberOfLines === b.numberOfLines,
);

/** Under a {@link HistoryFold} the body folds its quoted history; a clamped preview never does. */
export function BodyPages(props: BodyPagesProps) {
  const scope = useContext(FoldContext);
  return scope !== null && props.numberOfLines === undefined ? <FoldedPages scope={scope} {...props} /> : <Pages {...props} />;
}

/** Blank lines at either end of a stretch are the cut's, not the writer's. */
const trimmed = (s: string): string => s.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");

/**
 * The body cut at its history: the new words, the end marker (parent-relative, so it stays a direct
 * child of the panel: this is a fragment), the row, the history once opened, and what follows it.
 */
function FoldedPages({ scope, text, ...rest }: BodyPagesProps & { scope: FoldScope }) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").split("\n"), [text]);
  const range = useMemo(
    () => (text.length > QUOTED_HISTORY_LIMITS.chars ? null : quotedHistoryOfText(lines, { html: scope.verdict })),
    [text, lines, scope.verdict],
  );
  const end = scope.end ?? null;
  if (range === null) return <><Pages {...rest} text={text} />{end}</>;
  const open = openFor === scope.foldKey;
  const part = (from: number, to: number): string => trimmed(lines.slice(from, to).join("\n"));
  const before = part(0, range.start);
  const after = part(range.end, lines.length);
  const row = <HistoryRow key="row" open={open} onToggle={() => setOpenFor(open ? null : scope.foldKey)} />;
  const history = open ? <Pages key="h" {...rest} text={part(range.start, range.end)} /> : null;
  return range.at === "leading" ? (
    <>
      {before ? <Pages key="b" {...rest} text={before} /> : null}
      {row}
      {history}
      <Pages key="a" {...rest} text={after} />
      <Fragment key="end">{end}</Fragment>
    </>
  ) : (
    <>
      <Pages key="b" {...rest} text={before} />
      <Fragment key="end">{end}</Fragment>
      {row}
      {history}
      {after ? <Pages key="a" {...rest} text={after} /> : null}
    </>
  );
}

function Pages({ text, ...rest }: BodyPagesProps) {
  const [kept, setKept] = useState<{ text: string; pages: number }>({ text, pages: 1 });
  const asked = pagesAskedFor(kept, text);
  const plan = bodyPages(text, asked, rest.numberOfLines !== undefined);
  if (plan.pages === null) return <Txt {...rest}>{text}</Txt>;
  const more = plan.more;
  return (
    <>
      {/* The caller's top margin belongs above the first page, not between pages. */}
      {plan.pages.map((page, i) => (
        <Page key={i} {...rest} style={i === 0 ? rest.style : [rest.style, { marginTop: 0 }]} text={page} />
      ))}
      {more !== null ? (
        <Txt
          variant="caption"
          tone="accent"
          accessibilityRole="button"
          onPress={() => setKept({ text, pages: asked + 1 })}
          style={{ marginTop: 10 }}
        >
          {Copy.bodyShowMore(more)}
        </Txt>
      ) : null}
    </>
  );
}
