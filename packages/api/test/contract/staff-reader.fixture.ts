import {
  adminAccountDetail,
  type AdminDb, type AdminReader,
  type adminAccounts, type adminAccountsByIds, type adminActions, type adminSearch, type adminWorker,
} from "@trafficflow/services";

/**
 * EVERY STAFF READ THAT CAN SERVE A CUSTOMER ADDRESS TAKES THE READER, AND NONE DEFAULTS IT.
 *
 * A read that answered an address took its masking decision from a parameter that defaulted to
 * an owner reader (`adminAccountDetail`) or took no reader at all and was masked by the route
 * (`adminAccounts`). A caller that forgot the reader got every address whole, and nothing failed.
 * These assertions are types; the root `tsc -b` compiles this directory through the package's
 * contract tsconfig, so an optional or missing reader fails the build.
 */

/** Invariant type equality: an optional parameter (`AdminReader | undefined`) does not pass. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export type AccountsTakeAReader = Expect<Equal<Parameters<typeof adminAccounts>[3], AdminReader>>;
export type AccountPageTakesAReader = Expect<Equal<Parameters<typeof adminAccountDetail>[3], AdminReader>>;
export type BatchTakesAReader = Expect<Equal<Parameters<typeof adminAccountsByIds>[3], AdminReader>>;
export type SearchTakesAReader = Expect<Equal<Parameters<typeof adminSearch>[3], AdminReader>>;
export type WorkerTakesAReader = Expect<Equal<Parameters<typeof adminWorker>[2], AdminReader>>;
export type ActionsTakeAReader = Expect<Equal<Parameters<typeof adminActions>[2], AdminReader>>;

// @ts-expect-error — the account page without a reader does not compile: there is no default.
export const accountPageWithoutReader = (db: AdminDb, now: Date): unknown => adminAccountDetail(db, now, "");
