/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { FocusFollows } from "@ohmail/app-logic/keys/focus-follows";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
let root: Root | null = null;
let modal: HTMLDivElement;
let choice: HTMLInputElement;
let field: HTMLInputElement;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  choice = document.createElement("input");
  choice.type = "radio";
  choice.checked = true;
  field = document.createElement("input");
  field.type = "email";
  modal.append(choice, field);
  const host = document.createElement("div");
  document.body.append(modal, host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => { mounted.render(React.createElement(FocusFollows)); });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => { mounted.unmount(); });
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("focus while a person moves between modal controls", () => {
  it("does not steal a text-field click during the browser's blur/focus gap", async () => {
    choice.focus();
    choice.blur();
    // WebKitGTK can deliver a DOM mutation here before completing the click's focus move.
    // jsdom moves focus synchronously, so model the captured gap explicitly.
    modal.append(document.createElement("span"));
    await Promise.resolve();
    expect(document.activeElement, "the modal stole focus before the click finished").toBe(document.body);

    field.focus();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(field);
  });

  it("still puts focus in the modal when its focused control is removed", async () => {
    choice.focus();
    choice.remove();
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(field);
  });

  it("does not move focus after its owner unmounts", async () => {
    choice.focus();
    choice.blur();
    modal.append(document.createElement("span"));
    await Promise.resolve();
    const mounted = root!;
    root = null;
    await act(async () => { mounted.unmount(); });
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(document.body);
  });
});
