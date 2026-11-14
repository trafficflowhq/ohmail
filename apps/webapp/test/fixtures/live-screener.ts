import { within } from "@testing-library/react";
import messages from "../../messages/en.json";
import { act, tick } from "./live-walk-shell";

const copy = messages.screener;
const rows = (host: HTMLElement) => host.querySelectorAll<HTMLElement>(
  `[role="listbox"][aria-label="${copy.title}"] [role="option"][data-id]`,
);

const destinations = {
  ohbox: copy.pileOhbox,
  reads: copy.pileReads,
  receipts: copy.pileReceipts,
  screened: copy.pileScreened,
  spam: copy.pileSpam,
};

export const screenerRowIds = (host: HTMLElement): string[] =>
  [...rows(host)].map((row) => row.dataset.id!);

export const screenerRow = (host: HTMLElement, id: string): HTMLElement | undefined =>
  [...rows(host)].find((row) => row.dataset.id === id);

export async function selectScreenerRow(host: HTMLElement, id: string): Promise<void> {
  const row = screenerRow(host, id);
  if (!row) throw new Error(`No Screener row ${id}. Found ${screenerRowIds(host).join(", ") || "none"}.`);
  await act(async () => { row.click(); });
  await tick(0);
}

export async function decideScreenerRow(
  host: HTMLElement,
  id: string,
  destination: keyof typeof destinations,
): Promise<void> {
  const row = screenerRow(host, id);
  if (!row) throw new Error(`No Screener row ${id}. Found ${screenerRowIds(host).join(", ") || "none"}.`);
  await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await tick(0);
  const menu = within(document.body).getByRole("menu", { name: copy.rowMoreAria });
  within(menu).getByRole("menuitem", { name: destinations[destination] }).click();
  await tick(0);
  if (destination !== "spam" && destination !== "screened") return;
  const name = copy.place.unsub[destination];
  const confirmation = within(document.body).queryByRole("dialog", { name });
  if (confirmation) {
    within(confirmation).getByRole("button", {
      name: (label) => label === name || label === messages.screening.unsubCommitMaybe,
    }).click();
    await tick(0);
  }
}

export function releaseScreenerRow(host: HTMLElement, destination: "ohbox" | "reads" | "waiting"): void {
  const actions = within(host).getByRole("toolbar", { name: copy.place.panel });
  const name = destination === "waiting" ? copy.place.toWaiting : destinations[destination];
  within(actions).getByRole("button", { name }).click();
}

export function screenerReport(): string {
  return document.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent ?? "";
}
