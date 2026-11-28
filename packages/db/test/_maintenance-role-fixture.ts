import postgres from "postgres";

export { eq, inArray, sql, type SQL } from "drizzle-orm";

/** Open one connection to the throwaway database so the test can provision its roles. */
export function connectMaintenanceFixture(url: string): ReturnType<typeof postgres> {
  return postgres(url, { max: 1, onnotice: () => {} });
}
