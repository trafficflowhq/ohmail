import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./concurrent-index.js";

/** Validate after the mail journal commits, so the scan can run alongside session writes. */
export async function validateCalendarSessionScope(db: SqlExecutor): Promise<void> {
  await db.execute(sql`do $$
    begin
      if exists (
        select 1 from pg_constraint
        where conrelid = to_regclass('public.sessions')
          and conname = 'sessions_scope_check' and not convalidated
      ) then
        alter table public.sessions validate constraint sessions_scope_check;
      end if;
    end;
  $$`);
}
