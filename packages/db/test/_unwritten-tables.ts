/**
 * TABLES THE SCHEMA DECLARES AND NOTHING WRITES YET.
 *
 * A table arrives in the journal before the code that fills it when the journal has to be whole
 * on one day and the code is built after it. Until its first writer exists no store holds a row
 * of it, so the censuses that ask "who sweeps it, who seeds it, who bounds what a sender wrote
 * into it" have nothing to ask about. They read this list instead of each carrying an exemption
 * of its own, and `inbound-header-index-bounds.test.ts` holds the list to the tree: the first
 * statement anywhere in the product that inserts into one of these turns it red. Whoever writes
 * that statement takes the table off this list, and each census that leaned on it then asks its
 * own question of the table: the two erasures and the device's removal walk, their fixtures, the
 * staff surface's sweep, and the bound of each indexed text column.
 *
 * Keyed by SQL name; `name` is the schema's export. `cloud` marks a table of the Cloud journal:
 * no desktop and no phone holds it, so the censuses of the mail half's two erasures never ask.
 */
export interface UnwrittenTable { readonly name: string; readonly why: string; readonly cloud?: true }

const CALENDAR = "the calendar's sync and acts are not built yet: no account holds a row";

/* The calendar's records, its six record tables, are written by a desktop's copy of a Cloud
   account (`cloud-mirror-calendar.ts`) and left this list with that writer; `cal_settings` left it
   with the switch (`settings-service.ts`, and the copy's `storeCalendarSwitch`); `cal_writes` with
   the write door (`packages/services/src/calendar/writes.ts`). */
export const UNWRITTEN_TABLES: Readonly<Record<string, UnwrittenTable>> = {
  cal_credentials: { name: "calCredentials", why: CALENDAR },
  cal_links: { name: "calLinks", why: CALENDAR },
  cal_push_channels: { name: "calPushChannels", cloud: true, why: CALENDAR },
  account_closures: { name: "accountClosures", cloud: true, why: "the staff act that closes an account is not built yet: no account is closed" },
};

const MAIL_HALF = Object.entries(UNWRITTEN_TABLES).filter(([, t]) => t.cloud !== true);

/** The mail journal's part of the list, keyed by the schema's export names, each with its reason. */
export function unwrittenByExport(): Record<string, string> {
  return Object.fromEntries(MAIL_HALF.map(([table, t]) => [t.name, `${t.why} (\`${table}\`, unwritten)`]));
}

/** The mail journal's part of the list, keyed by SQL name, each with its reason. */
export function unwrittenBySqlName(): Record<string, string> {
  return Object.fromEntries(MAIL_HALF.map(([table, t]) => [table, `${t.why} (unwritten)`]));
}
