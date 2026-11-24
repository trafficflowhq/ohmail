/**
 * THE ONE WAY A PART SAYS WORDS IT APPEARS WITH. A live region is said when its words change after it stands;
 * one that arrives already holding its words is passed over by several screen readers. So a part that becomes
 * such a region on a running page draws its words at once and keeps them from a screen reader until the region
 * has stood for a frame, then gives them to it: to the reader that is a change inside a region that was there.
 *
 * Drawn by a server, or taken up from a server's markup, the words are the reader's from the start: a page is
 * read from its top and needs no announcement, and without script nothing would ever give the words back.
 * Words that change while the region stands are held back by nothing: that change is said by itself.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

const never = () => () => {};

/**
 * Whether the words of a part that is `live` (a region that is said) are still kept from a screen reader: the
 * part marks the node that holds them `aria-hidden` while this is true, and draws them all the same.
 */
export function useSaidOnArrival(live: boolean): boolean {
  const fromServer = useSyncExternalStore(
    never,
    () => false,
    () => true,
  );
  /* What a reader already has of this region: all of it where a server drew it. */
  const [given, setGiven] = useState(fromServer && live);
  useEffect(() => {
    if (!live) {
      setGiven(false);
      return;
    }
    /* Two frames: the region has been drawn, and read by the browser, without its words. */
    if (typeof requestAnimationFrame !== "function") {
      setGiven(true);
      return;
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setGiven(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [live]);
  return live && !given;
}
