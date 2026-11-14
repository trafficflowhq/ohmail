/**
 * A FIELD OF THE LETTER BY ITS NAME (To, the subject), found inside the letter's own sheet, the one the kit's composer
 * hands its ref: never by a search of the whole page, where another letter's or a panel's control can wear the name.
 */
export function fieldIn(sheet: HTMLElement | null, name: string): HTMLElement | undefined {
  return [...(sheet?.querySelectorAll<HTMLElement>('[role="combobox"], input, textarea') ?? [])].find(
    (field) => field.getAttribute("aria-label") === name,
  );
}
