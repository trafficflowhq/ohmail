/**
 * Code in a FOLDER named `folder.json`, for `no-host-census.test.ts` §6 (`reads-folder.ts` imports
 * the folder). Its one import resolves to nothing, so a crawl that walks this file reports the edge;
 * a crawl that took the folder for a data file never reads it. Fixture only: outside the tests'
 * tsconfig, and nothing else imports it.
 */
export * from "./not-a-module";
