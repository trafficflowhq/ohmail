import { useEffect, useRef, type ReactNode } from "react";

export interface KbdProps {
  children: ReactNode;
  className?: string;
  /** The control's shortcut in `aria-keyshortcuts` syntax ("r", "Shift+F"), set on the control it sits in. */
  shortcut?: string;
}

/** What a keycap can sit inside and be read as part of: a control whose name is its content. */
const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="link"]';

/** The control's own words: its text without keycaps and without hidden subtrees. */
function wordsOf(el: Node): string {
  if (el.nodeType === 3) return el.textContent ?? "";
  if (!(el instanceof Element) || el.tagName === "KBD" || el.getAttribute("aria-hidden") === "true") return "";
  return [...el.childNodes].map(wordsOf).join("");
}

/**
 * Keycap — one of Blanc's few deliberate hairlines (styled in base.css). Inside a control it is
 * drawn and not read: the control's name is its words, and the key is stated in
 * `aria-keyshortcuts` where the caller knows it. A keycap that is a control's only text stays.
 */
export function Kbd({ children, className, shortcut }: KbdProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const kbd = ref.current;
    const control = kbd?.parentElement?.closest<HTMLElement>(CONTROL);
    if (!kbd || !control) return undefined;
    const named = control.hasAttribute("aria-label") || control.hasAttribute("aria-labelledby");
    if (!named && wordsOf(control).trim() === "") return undefined;
    kbd.setAttribute("aria-hidden", "true");
    if (!shortcut || control.hasAttribute("aria-keyshortcuts")) return undefined;
    control.setAttribute("aria-keyshortcuts", shortcut);
    return () => { if (control.getAttribute("aria-keyshortcuts") === shortcut) control.removeAttribute("aria-keyshortcuts"); };
  }, [shortcut, children]);
  return <kbd ref={ref} className={className}>{children}</kbd>;
}
