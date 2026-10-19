import { describe, expect, it } from "vitest";
import { STAFF_ROLES } from "@trafficflow/db/cloud";
import { addressFor, readerMasksAddresses } from "../src/admin-service.js";
import type { StaffRole } from "../src/admin-dto.js";

/**
 * WHO READS A CUSTOMER'S ADDRESS WHOLE. A reader holding owner, support or billing works with
 * people and is served the address; every other reader is served its domain: `ops` alone, a
 * reader with no role, and a role this build does not name. The rule names the roles that see,
 * so a role added later is masked until somebody decides otherwise.
 */

const PEOPLE: readonly StaffRole[] = ["owner", "support", "billing"];

/** Every subset of the roles, the empty one included. */
const subsets = (roles: readonly StaffRole[]): StaffRole[][] =>
  roles.reduce<StaffRole[][]>((acc, role) => [...acc, ...acc.map((set) => [...set, role])], [[]]);

describe("a reader without a people role is served addresses masked", () => {
  it("masks exactly the role sets that hold none of owner, support or billing", () => {
    const sets = subsets(STAFF_ROLES);
    expect(sets).toHaveLength(16);
    const wrong = sets
      .filter((roles) => readerMasksAddresses({ roles }) !== !roles.some((r) => PEOPLE.includes(r)))
      .map((roles) => `[${roles.join(", ")}]`);
    expect(wrong).toEqual([]);
  });

  it("masks a reader with no role and one holding a role this build does not name", () => {
    expect(readerMasksAddresses({ roles: [] })).toBe(true);
    expect(readerMasksAddresses({ roles: ["auditor" as StaffRole] })).toBe(true);
  });

  it("addressFor keeps the domain for a masked reader and the whole value for a people role", () => {
    const ops = addressFor({ roles: ["ops"] });
    expect(ops("anna@alpha.example")).toBe("•••@alpha.example");
    expect(ops("")).toBe("");
    expect(ops("no-at-sign")).toBe("•••");
    const owner = addressFor({ roles: ["owner"] });
    expect(owner("anna@alpha.example")).toBe("anna@alpha.example");
    expect(owner("")).toBe("");
  });
});
