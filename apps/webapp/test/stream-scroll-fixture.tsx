import * as React from "react";
import { useStreamScroll, type StreamScroll, type StreamScrollOptions } from "@ohmail/app-logic/streams";

type Props = Pick<StreamScrollOptions, "contentKey" | "cursor" | "onCurrentChange" | "pileIndexOf"> & {
  ref?: React.Ref<StreamScroll>;
  children: React.ReactNode;
};

// Geometry belongs to each test. The hook takes the same scroller and card coordinates as the live stream.
export function StreamScrollFixture({ ref, children, ...options }: Props) {
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
  const scroll = useStreamScroll({
    ...options,
    scroller,
    card: { base: "scast", attr: "data-sid", pending: "pend" },
  });
  React.useImperativeHandle(ref, () => scroll, [scroll]);
  return <div ref={setScroller} aria-label="stream" role="region">{children}</div>;
}
