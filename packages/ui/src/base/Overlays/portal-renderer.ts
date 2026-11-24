import { createContext, type ReactNode } from "react";

/** The browser entry supplies its renderer. Static kit renders keep the content inline. */
export const portalRenderer = createContext<(content: ReactNode, container: HTMLElement) => ReactNode>(
  (content) => content,
);
