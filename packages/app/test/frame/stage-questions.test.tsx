/** @vitest-environment jsdom */
/**
 * A QUESTION SETUP ASKS STANDS IN SETUP. Setup stands over the whole window, above every layer a question drawn in the
 * page's body would take, so a question it asks (Cancel setup?, the second factor) is drawn inside it: drawn in the
 * body, it stood under setup, unseen, while it held the keys.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "@ohmail/ui/base";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import { Stage } from "../../src/frame/Stage.js";

afterEach(cleanup);

const asked = (inStage: boolean) => {
  const question = (
    <Dialog
      open
      onClose={() => {}}
      title="Cancel setup"
      confirm={{ label: "Close setup", onPress: () => {} }}
      cancel={{ label: "Back" }}
    />
  );
  render(
    <portalRenderer.Provider value={createPortal}>
      <Stage open label="Setup">
        <p>Step</p>
        {inStage ? question : null}
      </Stage>
      {inStage ? null : question}
    </portalRenderer.Provider>,
  );
  return screen.getByRole("dialog", { name: /^Cancel setup/ });
};

describe("the stage's questions", () => {
  it("a question setup asks is drawn inside setup, which stands over the whole window", () => {
    const question = asked(true);
    expect(question.closest(".fr-stage")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close setup" }));
  });

  it("a question asked outside setup still stands over the whole window from the page's body", () => {
    const question = asked(false);
    expect(question.closest(".fr-stage")).toBeNull();
    expect(question.closest(".oh-over")?.parentElement).toBe(document.body);
  });
});
