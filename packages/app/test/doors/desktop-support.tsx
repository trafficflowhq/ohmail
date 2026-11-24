/** What the desktop pages' tests share: a step-up door that never answers, the four answers as spies, the drawing. */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { TextProvider } from "../../src/text/index.js";
import type { StepUpDoor, StepUpProps } from "../../src/doors/step-up/index.js";

export const waitingStepUp: StepUpDoor = {
  factors: () => new Promise(() => {}),
  verify: () => new Promise(() => {}),
};

export function factorSpies(): StepUpProps & { onOwnerAbsent: () => void } {
  return { onVerified: vi.fn(), onCancel: vi.fn(), onDiscarded: vi.fn(), onOwnerAbsent: vi.fn() };
}

export function drawIn(page: ReactNode, words: Record<string, unknown>, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={words as never} timeZone="UTC">
      {page}
    </TextProvider>,
  );
}

/** A sentence as the page says it: the catalogue's closing full stop is the page's dot. */
export const stop = (s: string): string => s.replace(/\.$/, "");
