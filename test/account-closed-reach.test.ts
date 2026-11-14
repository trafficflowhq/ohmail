/**
 * WHAT A CLOSED ACCOUNT STILL REACHES, HELD AGAINST THE SERVER'S OWN TABLE. The account panes' contract says, per
 * member of each door, which routes it asks and whether the server still answers them for an account the service has
 * refused. The server decides that by a route's class and one short list of named routes; this reads both off the
 * route table itself, so a route that changes class, or a row written from memory, is red here.
 */
import { describe, expect, it } from "vitest";
import { accessRefusedMayReach, apiRoutes } from "@trafficflow/api";
import { ACCOUNT_DOORS, CLOSED_ACCOUNT_REACH } from "../packages/app/src/account/contract.js";

const mounted = (asked: string) => {
  const [method, pattern] = asked.split(" ");
  return apiRoutes.find((route) => route.method === method && route.pattern === pattern);
};
const rows = ACCOUNT_DOORS.flatMap((door) =>
  Object.entries(CLOSED_ACCOUNT_REACH[door]).map(([member, row]) => ({ name: `${door}.${member}`, ...row })),
);

describe("what a closed account still reaches, as the server's route table answers it", () => {
  it("every member is reached exactly where every route it asks is", () => {
    const wrong = rows
      .filter((row) => {
        const answered = row.asks.every((asked) => {
          const route = mounted(asked);
          return route !== undefined && accessRefusedMayReach(route);
        });
        return answered !== row.answered;
      })
      .map((row) => row.name);
    expect(wrong).toEqual([]);
  });

  it("names only routes the server mounts, but the plans' read, which is not on this branch yet", () => {
    const unmounted = [...new Set(rows.flatMap((row) => row.asks))].filter((asked) => mounted(asked) === undefined);
    expect(unmounted).toEqual(["GET /account/plans"]);
  });

  it("asks a route for every act of the server's: only a copy, a way to another page and the browser ask none", () => {
    const asksNothing = rows.filter((row) => row.asks.length === 0).map((row) => row.name);
    expect(asksNothing.sort()).toEqual(
      ["account.toErase", "account.toSignIn", "devices.copy", "invites.copy", "wayOut.open"].sort(),
    );
  });
});
