import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ACCOUNT_TABLES } from "../src/account-rows.js";
import { ACCOUNT_ROWS_SQL, ACCOUNT_VIEW_RELATIONS, accountRows, accountRowsAnswered } from "../src/row-security/account-road.js";
import { ACCOUNT_VIEWS, viewName } from "../src/row-security/views.js";
import * as shared from "../src/index.js";
import * as hosted from "../src/cloud.js";

/**
 * WHICH RELATIONS AN ACCOUNT'S INDEX-DRIVEN READS NAME, without a server of the lock: the answer's two
 * shapes are the lock's list's, a device's store (no runtime login, no views) answers the tables, and the
 * catalog is asked once per pool handle. The answer on a store with the views, for the logins and for
 * every other role, is proven on the lock's ground (`packages/services/test/row-security-isolation.pg.test.ts`).
 */
describe("accountRows", () => {
  it("names the lock's three views, or their tables", () => {
    const byName = new Map(ACCOUNT_VIEWS.map((v) => [v.name, v]));
    expect(ACCOUNT_VIEW_RELATIONS).toEqual({
      through: "views", messages: viewName(byName.get("messages")!), messageSearch: viewName(byName.get("message_search")!),
      messageSearchWords: viewName(byName.get("message_search_words")!),
    });
    expect(ACCOUNT_TABLES).toEqual({
      through: "tables", messages: "public.messages", messageSearch: "public.message_search", messageSearchWords: "public.message_search",
    });
    // The tables' answer writes plain names (its module imports nothing, so a device's engine may load it): each is its listed view's table.
    expect(ACCOUNT_TABLES).toEqual({
      through: "tables", messages: `public.${byName.get("messages")!.table}`, messageSearch: `public.${byName.get("message_search")!.table}`,
      messageSearchWords: `public.${byName.get("message_search_words")!.table}`,
    });
    // The search document's census watches these words: whoever takes the document's name from the answer writes
    // `messageSearch` or `messageSearchWords`. A key renamed is a census change (the census ruling (a), its third condition).
    for (const shape of [ACCOUNT_TABLES, ACCOUNT_VIEW_RELATIONS]) expect(Object.keys(shape).sort()).toEqual(["messageSearch", "messageSearchWords", "messages", "through"]);
  });

  it("the package's root offers the tables' answer alone; the catalog read and the views' answer are the hosted entry's", () => {
    // Every engine loads the root, a phone's among them: an export of the hosted part there ships a statement only
    // Postgres accepts, and the lock's list with every locked table's name, to a device (the phone's own tests read its bundle).
    const HOSTED = ["accountRows", "accountRowsAnswered", "accountRowsLine", "ACCOUNT_ROWS_SQL", "ACCOUNT_VIEW_RELATIONS"];
    expect({ root: HOSTED.filter((name) => name in shared), hosted: HOSTED.filter((name) => name in hosted) }).toEqual({ root: [], hosted: HOSTED });
    expect(shared.ACCOUNT_TABLES).toBe(ACCOUNT_TABLES);
  });

  it("a device's store, with no runtime login and no views, reads the tables, and is asked once", async () => {
    const pg = new PGlite();
    const db = drizzle(pg);
    let asked = 0;
    const counting = { execute: (q: typeof ACCOUNT_ROWS_SQL) => { asked += 1; return db.execute(q); } };
    expect(await accountRows(counting)).toBe(ACCOUNT_TABLES);
    expect(await accountRows(counting)).toBe(ACCOUNT_TABLES);
    expect(asked).toBe(1);
    await pg.close();
  });

  it("each pool handle says its road once, when it is first answered: which relations and what kind of role, never an account or an address; asked nothing, the road it was answered", async () => {
    const said: string[] = [];
    const log = (line: string): void => { said.push(line); };
    /** A store that answers the catalog read as `row`. */
    const answering = (row: { views: boolean; login: string | null }) => ({ execute: async () => [row] });
    const api = answering({ views: true, login: "ohmail_api" });
    const gap = answering({ views: false, login: "ohmail_worker" });
    const other = answering({ views: false, login: null });
    expect([accountRowsAnswered(api), accountRowsAnswered(gap), accountRowsAnswered(other)]).toEqual([null, null, null]);
    expect([(await accountRows(api, { log })).through, (await accountRows(gap, { log })).through, (await accountRows(other, { log })).through])
      .toEqual(["views", "tables", "tables"]);
    await accountRows(api, { log });
    await accountRows(other, { log });
    expect(said).toEqual([
      "account rows: this pool reads the account's views (the runtime login ohmail_api)",
      "account rows: this pool reads the tables (the runtime login ohmail_worker, to which the account's views are not all readable: a pool made after the roles' apply reads them)",
      "account rows: this pool reads the tables (a role that is no runtime login)",
    ]);
    expect([accountRowsAnswered(api), accountRowsAnswered(gap), accountRowsAnswered(other)]).toEqual(["views", "tables", "tables"]);
  });

  it("a read that fails is asked again, never kept", async () => {
    let asked = 0;
    const said: string[] = [];
    const failing = { execute: async () => { asked += 1; throw new Error("the catalog could not be read"); } };
    await expect(accountRows(failing, { log: (l) => said.push(l) })).rejects.toThrow(/could not be read/);
    await expect(accountRows(failing, { log: (l) => said.push(l) })).rejects.toThrow(/could not be read/);
    expect({ asked, said, answered: accountRowsAnswered(failing) }).toEqual({ asked: 2, said: [], answered: null });
  });
});
