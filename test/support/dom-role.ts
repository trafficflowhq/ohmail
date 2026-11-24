import { getByRole } from "@testing-library/react";

export function buttonNamed(container: HTMLElement, name: string): HTMLElement {
  return getByRole(container, "button", { name });
}
