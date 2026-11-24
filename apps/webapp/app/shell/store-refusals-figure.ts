import { activeFormatLocale } from "./locale";
import type { StoreRefusals } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE COUNT AS A PERSON READS IT, one spelling for every surface: the figure in the locale
 * `format.ts` formats with, or "more than N" (`more`, the catalogue's phrase) for a floor.
 */
export function storeRefusalsFigure(r: StoreRefusals, more: (figure: string) => string): string {
  const figure = new Intl.NumberFormat(activeFormatLocale()).format(r.count);
  return r.exact ? figure : more(figure);
}
