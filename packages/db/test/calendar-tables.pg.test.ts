import postgres from "postgres";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { calendarCatalogSuite } from "./_calendar-family.js";

/**
 * THE CALENDAR'S TABLES ON REAL POSTGRES: the same cases as on a desktop's store
 * (`calendar-tables.test.ts`), read from a server's own catalog and refusals.
 */
const HAVE_PG = await realPgAvailable(PG_TEST_URL);

calendarCatalogSuite("a server's store (Postgres)", async () => {
  const sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
  return {
    exec: async (text, params = []) => [...await sql.unsafe(text, [...params] as never[])] as Record<string, unknown>[],
    close: () => sql.end(),
  };
}, !HAVE_PG);
