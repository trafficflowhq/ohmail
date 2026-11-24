/** The address blank on the page, separate from the factor's own field. */
export function deleteAddress(container: HTMLElement): HTMLInputElement | null {
  return [...container.querySelectorAll<HTMLInputElement>("input")]
    .find((input) => input.closest('[role="dialog"]') === null) ?? null;
}

/** The page's button label, without any keyboard hint drawn beside it. */
export function deleteButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    [...button.childNodes].filter((node) => node.nodeName !== "KBD")
      .map((node) => node.textContent ?? "").join("").trim() === label) ?? null;
}

export function deleteCode(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[role="dialog"] input[autocomplete="one-time-code"]');
}
