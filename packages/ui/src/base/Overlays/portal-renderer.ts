import { createContext, type ReactNode } from "react";

/** The browser entry supplies its renderer. Static kit renders keep the content inline. */
export const portalRenderer = createContext<(content: ReactNode, container: HTMLElement) => ReactNode>(
  (content) => content,
);

/** Frame reports keep their own layer and tell popovers which space to leave clear. */
export const POPOVER_REPORT = "[data-popover-avoid]";

/** The nearest modal owns its popovers. Its scrollports and controls are siblings of the overlay. */
export function popoverHost(anchor?: Element | null): HTMLElement | undefined {
  const doc = anchor?.ownerDocument ?? globalThis.document;
  return (anchor ?? doc?.activeElement)?.closest<HTMLElement>('[aria-modal="true"]') ?? doc?.body;
}
