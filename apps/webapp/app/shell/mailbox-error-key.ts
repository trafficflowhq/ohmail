import { activeFormatLocale } from "./locale";
import type { StoreRefusals } from "./mail-state";

/**
 * THE `mailboxes.err_*` KEY A FAILING MAILBOX IS SAID WITH. The code is the class; a detail token
 * outranks it where the sentence differs: a server this deployment will not dial (its address, its
 * port, or a plaintext consent off the person's own network) was never dialled, and neither was one
 * whose stored password this install cannot use — "not available" would be false about each.
 * A `storage` failure that states its count ({@link StoreRefusals}) is said WITH the count, and
 * past what "Sync now" can retry with a louder sentence; without one the count-less sentence stands.
 */
export const PLAINTEXT_REFUSED_DETAIL = "MAILBOX_PLAINTEXT_REFUSED";

/**
 * THE DETAILS THAT CHANGE THE SENTENCE, one map. The dial door's three refusals are stored by the
 * organizer; the two credential ones are the desktop's own door, derived at read time and never
 * stored (`discloseLocalSyncFailures`).
 */
const DETAIL_KEYS: ReadonlyMap<string, string> = new Map([
  [PLAINTEXT_REFUSED_DETAIL, "err_plaintext_refused"],
  ["MAILBOX_HOST_REFUSED", "err_host_refused"],
  ["MAILBOX_PORT_REFUSED", "err_port_refused"],
  ["MAILBOX_CREDENTIAL_UNREADABLE", "err_credential_unreadable"],
  ["MAILBOX_CREDENTIAL_FOREIGN_HOST", "err_credential_foreign_host"],
]);

/** A catalogue key and the values it interpolates. */
export interface ErrorSentence {
  key: string;
  values?: { count: string; n: number };
}

/**
 * THE COUNT AS A PERSON READS IT, one spelling for every surface: the figure in the locale
 * `format.ts` formats with, or "more than N" (`more`, the catalogue's phrase) for a floor.
 */
export function storeRefusalsFigure(r: StoreRefusals, more: (figure: string) => string): string {
  const figure = new Intl.NumberFormat(activeFormatLocale()).format(r.count);
  return r.exact ? figure : more(figure);
}

export function mailboxErrorKey(
  errorCode: string | null,
  errorDetail?: string | null,
  refusals?: StoreRefusals,
  figure?: (r: StoreRefusals) => string,
): ErrorSentence {
  const detail = errorDetail ? DETAIL_KEYS.get(errorDetail) : undefined;
  if (detail) return { key: detail };
  if (errorCode === "storage" && refusals && refusals.count > 0 && figure) {
    const values = { count: figure(refusals), n: refusals.count };
    const capped = !refusals.exact || refusals.retrying < refusals.count;
    return { key: capped ? "err_storage_capped" : "err_storage_count", values };
  }
  return { key: errorCode ? `err_${errorCode}` : "syncError" };
}
