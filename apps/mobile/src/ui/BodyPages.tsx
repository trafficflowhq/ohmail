/**
 * A message body on the phone, a page at a time. A 2 MiB plain body handed to one Text blocked
 * the app for seconds each time it was shown; past `BODY_PAGE_CHARS` each page is its own Text
 * and "Show more" adds the next. The shown count keys on the text, so it never carries over to
 * the next message. A clamped caller (`numberOfLines`) draws the first page and offers no press.
 */
import { memo, useState } from "react";
import { Copy } from "../copy";
import { Txt, type TxtProps } from "./base";
import { bodyPages } from "./body-pages";

type BodyPagesProps = Omit<TxtProps, "children"> & { text: string };

/** One page, kept across a further press: only the new page is laid out. */
const Page = memo(
  function Page({ text, ...rest }: BodyPagesProps) {
    return <Txt {...rest}>{text}</Txt>;
  },
  (a, b) => a.text === b.text && a.variant === b.variant && a.tone === b.tone && a.selectable === b.selectable,
);

export function BodyPages({ text, numberOfLines, ...rest }: BodyPagesProps) {
  const [shown, setShown] = useState<{ text: string; pages: number }>({ text, pages: 1 });
  const asked = shown.text === text ? shown.pages : 1;
  const plan = bodyPages(text, asked);
  if (plan.pages === null) {
    return <Txt {...rest} numberOfLines={numberOfLines}>{text}</Txt>;
  }
  if (numberOfLines !== undefined) {
    return <Txt {...rest} numberOfLines={numberOfLines}>{plan.pages[0]}</Txt>;
  }
  const more = plan.more;
  return (
    <>
      {plan.pages.map((page, i) => <Page key={i} {...rest} text={page} />)}
      {more !== null ? (
        <Txt
          variant="caption"
          tone="accent"
          accessibilityRole="button"
          onPress={() => setShown({ text, pages: asked + 1 })}
          style={{ marginTop: 10 }}
        >
          {Copy.bodyShowMore(more)}
        </Txt>
      ) : null}
    </>
  );
}
