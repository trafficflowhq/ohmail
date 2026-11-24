/**
 * THE GROUP'S STATES, JOINED: `ACCOUNT_STATES` holds every pane of the group and the card, and across all of them a
 * picture of the comparison is drawn by one state alone. (Each pane's own cases hold that its addresses are
 * registered and cover its pictures; this holds that no two panes claim one.)
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PANES, type AccountState } from "../../src/account/contract.js";
import { ACCOUNT_STATES } from "../../src/account/index.js";
import registry from "../../../../test/compare/registry.json" with { type: "json" };
import { CODE, LAPTOP, PHONE, plain, THIS } from "./devices/fake-door.js";
import { FOR_RAHEL } from "./invites/fake-door.js";
import { READS } from "./subscription/fake-door.js";

/* The page's own fixtures, as each pane's cases hand them: no source file holds a link, a key or an amount. */
const PART = createHash("sha256").update("account states fixture").digest("base64url");
const FAILED = "The server could not be reached.";
const AMOUNTS = {
  plan: { solo: "$9/month", plus: "$15/month", pro: "$29/month" },
  addon: "$5/month",
} as const;

const BUILT: Readonly<
  Record<keyof typeof ACCOUNT_STATES, Readonly<Record<string, AccountState<unknown, string>>>>
> = {
  devices: ACCOUNT_STATES.devices({
    sessions: [THIS, PHONE, LAPTOP, plain(3), plain(2)],
    code: CODE,
    link: `https://api.ohmail.example/pair#${PART}`,
    failed: FAILED,
  }),
  billing: ACCOUNT_STATES.billing(READS.card.value),
  storage: ACCOUNT_STATES.storage(AMOUNTS),
  invites: ACCOUNT_STATES.invites({
    invite: FOR_RAHEL,
    link: `https://mail.lichtgrat.example/join/invite#${PART}`,
    failed: FAILED,
  }),
  security: ACCOUNT_STATES.security({ codes: ["58049-86391"], key: PART.slice(0, 16), failed: FAILED }),
  account: ACCOUNT_STATES.account({ address: "mila@lichtgrat.example", failed: FAILED }),
  storageFacts: ACCOUNT_STATES.storageFacts(),
  password: ACCOUNT_STATES.password,
  wayOut: ACCOUNT_STATES.wayOut,
};

describe("the account group's states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const drawn = Object.entries(BUILT).flatMap(([pane, states]) =>
    Object.entries(states).flatMap(([name, state]) =>
      state.address === null ? [] : [{ at: `${pane}.${name}`, address: state.address }],
    ),
  );

  it("hold every pane of the group, beside Storage's facts, the password form alone and the card", () => {
    for (const pane of ACCOUNT_PANES) expect(Object.keys(BUILT[pane]).length, pane).toBeGreaterThan(0);
    expect(Object.keys(ACCOUNT_STATES).sort()).toEqual(
      [...ACCOUNT_PANES, "storageFacts", "password", "wayOut"].sort(),
    );
  });

  it("name only addresses the comparison registers", () => {
    expect(drawn.filter(({ address }) => !registered.has(address))).toEqual([]);
  });

  it("give a picture to one state alone, across the panes", () => {
    const byAddress = new Map<string, string[]>();
    for (const { at, address } of drawn) byAddress.set(address, [...(byAddress.get(address) ?? []), at]);
    // The password form's states are the Account pane's, drawn open: the wall's form and the pane share a picture.
    const twice = [...byAddress.values()].filter(
      (ats) => ats.filter((at) => !at.startsWith("password.")).length > 1,
    );
    expect(twice).toEqual([]);
  });
});
