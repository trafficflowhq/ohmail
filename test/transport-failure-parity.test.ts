import { describe, expect, it } from "vitest";
import { TRANSPORT_CODES, TRANSPORT_PREFIXES } from "../packages/cal-providers/src/request/guarded.js";
import { isTransportFailure } from "../packages/services/src/privacy-service.js";

/**
 * A FAILED REQUEST FOR THE CALENDAR IS A FAILED FETCH FOR THE PICTURE PROXY. Both ask through the product's one pinned
 * request and read the code it fails with. The calendar's request port answers `connection_failed` for every code and
 * family on its list; the picture proxy answers 424 for those on its own, and 500 with a fault row for any other.
 * Whoever runs the server a letter names chooses what it sends, so a code the calendar reads as the far side failing and
 * the proxy does not is a server error any sender can raise: `UNSPECIFIED`, the platform's code for a certificate fault
 * its table does not name, was one. Both lists are read from the code. A code on the calendar's list that must stay a
 * fault of the proxy's own is named below, with the reason, and held to stay one.
 */
const OURS_AT_THE_PROXY: ReadonlyMap<string, string> = new Map([
  ["OUT_OF_MEM", "the platform's check of a chain could not get the memory it asked for: this server failing, not the "
    + "chain, and a server out of memory is what the 500 and its fault row are for"],
  ["ERR_OSSL_", "the platform's code for a cryptography call that failed on this program's own inputs (a key, a "
    + "certificate, a context); a far side's bytes fail a request with EPROTO, ERR_SSL_ or a certificate's code instead"],
]);

/** A code in `family` that no table names yet: what the platform's next code there looks like. */
const unnamedIn = (family: string): string => `${family}A_CODE_NO_TABLE_NAMES_YET`;
const failsTheFetch = (code: string): boolean => isTransportFailure(Object.assign(new Error("the request failed"), { code }));

describe("the picture proxy reads every failed request the calendar's request port reads", () => {
  it("every code and every family on the calendar's list is a failed fetch for the proxy", () => {
    const missing = {
      codes: [...TRANSPORT_CODES].filter((code) => !OURS_AT_THE_PROXY.has(code) && !failsTheFetch(code)),
      families: TRANSPORT_PREFIXES.filter((family) => !OURS_AT_THE_PROXY.has(family) && !failsTheFetch(unnamedIn(family))),
    };
    expect(missing, "the calendar reads these as the far side failing, the picture proxy as a fault of its own")
      .toEqual({ codes: [], families: [] });
  });

  it.each([...OURS_AT_THE_PROXY.keys()])("%s is on the calendar's list, and stays a fault of the proxy's own", (named) => {
    const family = named.endsWith("_");
    expect(family ? TRANSPORT_PREFIXES.includes(named) : TRANSPORT_CODES.has(named), "the calendar no longer reads it so: drop it here")
      .toBe(true);
    expect(failsTheFetch(family ? unnamedIn(named) : named), OURS_AT_THE_PROXY.get(named)).toBe(false);
  });
});
