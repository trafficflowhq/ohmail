/**
 * EACH TABLE'S CLASS FOR ROW SECURITY, by SQL name, as data. The policies are generated from it
 * (the lock's own task); nothing here is a statement. A table is born with its row, so no table
 * reaches a store without a class.
 *
 * - `account`: row security on and forced; one policy for the API's and the worker's roles, the
 *   row's account is the one named for the transaction.
 * - `read before sign-in`: row security on and forced; a keyed policy admits a look-up by the
 *   token, code or address named for the transaction.
 * - `operations`: no row security, grants only.
 * - `staff`: row security on and forced; admitted to the API's role only while no account is bound.
 *
 * `workerReadsUnbound`: the worker's role reads every row before it binds an account (a roster it
 * walks), as a plain SELECT, never a lock. The staff role's read policy is derived from
 * `STAFF_SELECT_GRANTS`, never written here a second time. The list is the calendar's so far; the
 * lock completes it with every other table.
 */
export type TableClass = "account" | "read before sign-in" | "operations" | "staff";

export interface TableClassRow {
  readonly class: TableClass;
  readonly workerReadsUnbound?: true;
}

export const TABLE_CLASSES: Readonly<Record<string, TableClassRow>> = {
  // The calendar (mail 0205): every row is one account's.
  cal_connections: { class: "account", workerReadsUnbound: true },
  cal_credentials: { class: "account" },
  cal_calendars: { class: "account" },
  cal_events: { class: "account" },
  cal_attendees: { class: "account" },
  cal_alarms: { class: "account" },
  cal_writes: { class: "account" },
  cal_links: { class: "account" },
  cal_suggestions: { class: "account" },
  cal_settings: { class: "account" },
  // The providers' notice channels (cloud 0105): a notice names its channel before any account is known.
  cal_push_channels: { class: "read before sign-in", workerReadsUnbound: true },
};
