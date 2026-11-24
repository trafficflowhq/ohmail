import { cloneElement, Fragment, isValidElement, type ReactNode } from "react";
import { Dot, EndDot, Sentence } from "@ohmail/ui/base";
import "./sentence.css";

/**
 * A page's one sentence, ending in the dot: `hot` while something waits on the person, `ink` once it is done. The
 * catalogue's sentence keeps its own punctuation (a translation owns it): a closing full stop becomes the dot, a
 * sentence that ends on a word gets one, and one that ends on any other mark ("…", "?") is said as it stands. The
 * same rule as the website's `DotLabel`. A page's sentence is the page's own line, not a heading, as the design
 * draws it; the sign-in's is its heading (`level`).
 */
export function Said({
  text,
  dot = "hot",
  level,
}: {
  text: string;
  dot?: "hot" | "ink";
  level?: 1 | 2;
}): ReactNode {
  const words = text.endsWith(".") ? text.slice(0, -1) : text;
  const ends = /[\p{L}\p{N}]$/u.test(words);
  return (
    <Sentence size="xl" level={level}>
      {ends ? <EndDot kind={dot}>{words}</EndDot> : text}
    </Sentence>
  );
}

export function SaidTrail({ text }: { text: string }): ReactNode {
  return (
    <span className="oh-nowrap way-said-trail">
      {text}
      <Dot kind="hot" />
    </span>
  );
}

/**
 * An address in a sentence: it may break after its @, and the rest stays whole, with the closing dot where the address
 * ends the sentence. Drawn as text, never as markup.
 */
export function Address({ value, dot }: { value: string; dot?: ReactNode }): ReactNode {
  const at = value.lastIndexOf("@");
  return (
    <>
      {value.slice(0, at + 1)}
      {at < 0 ? null : <wbr />}
      <span className="way-nb">
        {value.slice(at + 1)}
        {dot}
      </span>
    </>
  );
}

/**
 * A sentence that holds a part, as the catalogue writes it with a tag (`<blank></blank>`, `<c>{code}</c>`): its closing
 * full stop becomes the dot, which stays with the part or with the last word, whichever ends the sentence.
 */
export function SaidWith({
  parts,
  dot = "hot",
  level,
  compact = false,
}: {
  parts: ReactNode;
  dot?: "hot" | "ink";
  level?: 1 | 2;
  compact?: boolean;
}): ReactNode {
  const list: ReactNode[] = Array.isArray(parts) ? [...(parts as ReactNode[])] : [parts];
  const last = list.at(-1);
  let end: ReactNode;
  if (typeof last === "string" && last.replace(/\.$/, "").trim() !== "") {
    list.pop();
    end = <EndDot kind={dot}>{last.replace(/\.$/, "")}</EndDot>;
  } else {
    if (typeof last === "string") list.pop();
    const part = list.pop();
    end =
      isValidElement<{ dot?: ReactNode }>(part) && part.type === Address ? (
        cloneElement(part, { dot: <Dot kind={dot} /> })
      ) : (
        <span className="way-nb">
          {part}
          <Dot kind={dot} />
        </span>
      );
  }
  return (
    <Sentence size={compact ? undefined : "xl"} level={level}>
      {list.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
      {end}
    </Sentence>
  );
}
