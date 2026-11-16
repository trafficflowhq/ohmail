import { useEffect, useRef, type Ref } from "react";
import { animate } from "../../motion/motion.js";
import "./sentence.css";

/* A refused blank shakes its head once. The travel has no token yet. */
const SHAKE: Keyframe[] = [
  { transform: "none" },
  { transform: "translateX(-6px)", offset: 0.25 },
  { transform: "translateX(5px)", offset: 0.55 },
  { transform: "translateX(-2px)", offset: 0.8 },
  { transform: "none" },
];

export interface BlankProps {
  /** What it wants, said to a screen reader: "email address". */
  label: string;
  /** What it wants, shown while it is empty. */
  placeholder: string;
  value?: string;
  /** Its width in letters while it is empty. */
  size?: number;
  type?: "text" | "email" | "password";
  /** What the browser may fill it with ("username", "current-password"); off unless said. */
  autoComplete?: string;
  /** The name it is sent and remembered by. */
  name?: string;
  /** The keyboard a phone opens for it: `numeric` for a code. */
  inputMode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  /** The answer was refused: it shakes once each time this turns true, and says so. */
  refused?: boolean;
  onChange?: (value: string) => void;
  /** Enter: go on. */
  onEnter?: () => void;
  /** Esc: go back. */
  onEscape?: () => void;
  ref?: Ref<HTMLInputElement>;
}

/** A blank to fill in a sentence. The dotted line is its mark, and nothing else carries it. */
export function Blank({
  label,
  placeholder,
  value,
  size,
  type = "text",
  autoComplete = "off",
  name,
  inputMode,
  refused,
  onChange,
  onEnter,
  onEscape,
  ref,
}: BlankProps) {
  const own = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (refused && own.current) animate(own.current, "shake", { ease: "--e-knock", keyframes: SHAKE });
  }, [refused]);
  return (
    <input
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className="oh-control oh-blank"
      type={type}
      name={name}
      inputMode={inputMode}
      value={value}
      size={size}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={refused ? true : undefined}
      autoComplete={autoComplete}
      spellCheck={false}
      readOnly={value !== undefined && !onChange}
      onChange={(e) => onChange?.(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onEnter?.();
        else if (e.key === "Escape") onEscape?.();
      }}
    />
  );
}
