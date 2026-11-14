/**
 * THE CONTROL for `no-host-census.test.ts` §6: a module that imports a data file that does not exist.
 * The census keeps it an unresolved edge, as any relative import it cannot resolve. Fixture only:
 * outside the tests' tsconfig, and nothing imports it.
 */
import data from "./no-such-file.json";

export default data;
