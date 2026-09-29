import { sql, type SQL } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { Db } from "./context.js";

/**
 * EACH ROW'S ARRIVAL KEY, as the store computes it and a `Date` reads it back — `Dialect.arrivalKey`
 * over `messages`, the one order every store read of mail takes (the views, folders, History, the
 * rail, the snapshot window, the triage piles). Both columns are bound only from JavaScript `Date`s,
 * so the key carries milliseconds and a cursor names the row it stopped at without a truncation.
 */
export function arrivalKeyOf(db: Db): SQL<Date> {
  return dialect(db).arrivalKey(sql`${messages.date}`, sql`${messages.arrivedAt}`).mapWith(messages.date) as SQL<Date>;
}
