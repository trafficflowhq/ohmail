/**
 * As a step opens, its first field, chosen radio or forward verb takes focus so Enter submits the step.
 * A place the person chose inside the stage stays. The two questions are the kit's dialog (`parts.tsx`): it takes
 * the keys as it is asked, keeps them while it stands, and gives them back to where the person was.
 */
import { useLayoutEffect, type RefObject } from "react";
import type { OnboardingStep } from "@ohmail/app-logic/doors/onboarding";

/** Where ↵ belongs as a step opens. */
const STEP_ENTRY =
  'input:not([type="hidden"]):enabled, [role="radio"][aria-checked="true"]:not(:disabled), button[type="submit"]:enabled';

/** A step's first control that can be pressed, where it has no field and no live forward verb. */
const FIRST_CONTROL =
  'button:enabled, input:not([type="hidden"]):enabled, select:enabled, textarea:enabled, a[href], [tabindex="0"]:not(:disabled)';

function focusFirst(root: HTMLElement, selector: string): boolean {
  for (const control of root.querySelectorAll<HTMLElement>(selector)) {
    if (control.closest("[hidden], [inert]")) continue;
    control.focus({ preventScroll: true });
    if (root.ownerDocument.activeElement === control) return true;
  }
  return false;
}

export function useStepEntry(root: RefObject<HTMLElement | null>, step: OnboardingStep | null): void {
  useLayoutEffect(() => {
    const stage = root.current;
    if (stage === null || step === null) return;
    const form = stage.querySelector<HTMLFormElement>('form[tabindex="-1"]');
    const active = stage.ownerDocument.activeElement;
    if (active !== stage && active !== form && stage.contains(active)) return;
    if (focusFirst(stage, STEP_ENTRY)) return;
    const material = stage.querySelector<HTMLElement>(".oh-page-material");
    if (material !== null && focusFirst(material, FIRST_CONTROL)) return;
    /* Recheck the entry while the form or stage holds focus so Continue gets it when the holder check answers. */
    (form ?? stage).focus({ preventScroll: true });
  });
}
