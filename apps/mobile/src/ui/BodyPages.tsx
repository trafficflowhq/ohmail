/**
 * A message body on the phone, a page at a time. A 2 MiB plain body handed to one Text froze the
 * app for over a minute when it was shown; past `BODY_PAGE_CHARS` each page is its own Text and
 * "Show more" adds the next. The count keys on the text, so it never carries over to the next
 * message. A clamped caller (`numberOfLines`) draws the first page and offers no press.
 */
import { memo, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { Txt, type TxtProps } from "./base";
import { bodyPages, pageBlocks, pagesAskedFor } from "./body-pages";

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

export function BodyPages({ text, ...rest }: BodyPagesProps) {
  const [kept, setKept] = useState<{ text: string; pages: number }>({ text, pages: 1 });
  const asked = pagesAskedFor(kept, text);
  const plan = bodyPages(text, asked, rest.numberOfLines !== undefined);
  if (plan.pages === null) return <Txt {...rest}>{text}</Txt>;
  const more = plan.more;
  return (
    <>
      {plan.pages.map((page, i) => <Page key={i} {...rest} text={page} />)}
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
