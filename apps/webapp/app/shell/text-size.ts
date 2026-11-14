import { applyTextSize as applyAtRoot, type TextSize } from "@ohmail/app-logic/text/text-size";

export * from "@ohmail/app-logic/text/text-size";

function textRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

export function applyTextSize(size: TextSize): void {
  applyAtRoot(size, textRoot());
}
