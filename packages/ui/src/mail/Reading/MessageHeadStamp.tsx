import type { MessageHeadProps } from "./MessageHead.js";

export function HeadStamp({ stamp, staticMetadata }: Pick<MessageHeadProps, "stamp" | "staticMetadata">) {
  const when = (
    <time className="oh-messagehead-when" dateTime={stamp.at}>
      {stamp.when}
    </time>
  );
  if (staticMetadata && !stamp.onPress) {
    return (
      <span className="oh-messagehead-stamp" title={stamp.title}>
        {when}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="oh-control oh-messagehead-stamp"
      aria-pressed={stamp.full}
      title={stamp.title}
      onClick={stamp.onPress}
    >
      {when}
    </button>
  );
}
