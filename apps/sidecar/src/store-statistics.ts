/**
 * THE SEARCH'S STATISTICS AFTER MAIL COMES IN — PGlite has no autovacuum, so a drain that took mail
 * is what makes the arms' tables stale between the backfill's own looks. The changes each drain
 * took are summed; once {@link STATISTICS_INGEST_ROWS} have passed since the last look, that drain's
 * end asks the store ONCE, and the store's 50 + 10 % rule decides which tables are analyzed.
 */
export const STATISTICS_INGEST_ROWS = 1_000;

interface StatisticsUpkeep {
  /** A drain took `rows` changes. `true` when this call asked the store. */
  noteIngested(rows: number): Promise<boolean>;
}

export function createStatisticsUpkeep(
  analyze: () => Promise<unknown>, everyRows: number = STATISTICS_INGEST_ROWS,
): StatisticsUpkeep {
  let since = 0;
  return {
    async noteIngested(rows) {
      since += Math.max(0, rows);
      if (since < everyRows) return false;
      since = 0;
      await analyze().catch(() => undefined);
      return true;
    },
  };
}
