/**
 * THE FOLDER ARM for `no-host-census.test.ts` §6: a module that imports `./folder.json`, which is a
 * FOLDER, not a data file. A folder of that name holds code (`folder.json/index.ts`), so the census
 * must not take it for the end of a path: only a FILE spelled `.json` is a leaf. Fixture only:
 * outside the tests' tsconfig, and nothing imports it.
 */
import data from "./folder.json";

export default data;
