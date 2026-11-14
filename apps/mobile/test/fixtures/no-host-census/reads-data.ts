/**
 * THE ADMIT ARM for `no-host-census.test.ts` §6: a module that imports a data file that exists. The
 * census resolves the edge to `data.json` and walks that file as a leaf: a data file imports nothing,
 * so its text, which holds an import as a string, is never read for edges. Fixture only: outside the
 * tests' tsconfig, and nothing imports it.
 */
import data from "./data.json";

export default data;
