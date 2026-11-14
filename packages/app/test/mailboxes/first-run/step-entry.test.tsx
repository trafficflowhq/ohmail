/** @vitest-environment jsdom */
/**
 * SETUP OPENED OVER THE APP TAKES THE KEYS FROM WHAT STANDS BEHIND IT (the switch's point 65, by RULING-JOIN J-1: today's
 * card took focus as it opened). A step opens with the keys on its first field, else its forward verb; a step with
 * neither takes them on the first control in its material, its form or the stage itself. A place the person
 * chose inside the stage stays theirs.
 */
import { cleanup, render } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import { Page } from "@ohmail/ui/base";
import { useStepEntry } from "../../../src/mailboxes/first-run/focus.js";

function StageOf({ step, children }: { readonly step: OnboardingStep; readonly children: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  useStepEntry(root, step);
  return (
    <div ref={root} role="dialog" aria-label="Set up" tabIndex={-1}>
      {children}
    </div>
  );
}

/** A control of the app, behind where the stage opens, holding the keys. */
function behind(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Set up";
  document.body.append(button);
  button.focus();
  return button;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("the keys as a step opens over a control that held them", () => {
  it("a step of choices with a Continue that waits: its first choice takes them", () => {
    const button = behind();
    render(
      <StageOf step="elsewhere">
        <form tabIndex={-1}>
          <Page
            material={
              <>
                <button type="button" disabled>
                  Check organizer
                </button>
                <button type="button">Organize here instead</button>
                <button type="button">Just read it here</button>
              </>
            }
            acts={
              <button type="submit" disabled>
                Continue
              </button>
            }
          >
            Organize this mailbox
          </Page>
        </form>
      </StageOf>,
    );
    expect(document.activeElement).not.toBe(button);
    expect(document.activeElement?.textContent).toBe("Organize here instead");
  });

  it("a step with no control at all: the stage itself takes them", () => {
    behind();
    render(
      <StageOf step="welcome">
        <p>Getting things ready</p>
      </StageOf>,
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Set up");
  });

  it("a field still comes first, and a place chosen inside the stage stays", () => {
    behind();
    const { rerender } = render(
      <StageOf step="mailbox">
        <button type="button">Back</button>
        <input aria-label="Address" />
      </StageOf>,
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Address");
    (document.querySelector("button") as HTMLButtonElement | null)?.focus();
    const chosen = [...document.querySelectorAll("button")].find((b) => b.textContent === "Back")!;
    chosen.focus();
    rerender(
      <StageOf step="consent">
        <button type="button">Back</button>
        <input aria-label="Address" />
      </StageOf>,
    );
    expect(document.activeElement).toBe(chosen);
  });
});
