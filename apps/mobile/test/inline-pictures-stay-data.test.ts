/**
 * THE PHONE KEEPS ITS EMBEDDED PICTURES AS `data:` URIs. Its reading WebView cannot read an object
 * URL this runtime mints, and its document admits `img-src data:` alone (`mail-document.ts`), so
 * `bootEngine` says `inlineImageUrls: "data"` while the browser doors say `"object"`. Driven
 * through the real boot composition (account guard, HTTP adapter, sqlite mirror); only the server
 * is a stand-in. Set to `"object"`, the value is a `blob:` the WebView would draw as a blank box.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import { bootEngine } from "../src/engine/boot";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function memoryExecutor(): SqlExecutor {
  const db: DatabaseSync = new sqlite.DatabaseSync(":memory:");
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function phoneServer(url: string): Promise<Response> {
  if (url.endsWith("/messages/m1/attachments")) {
    return json(200, {
      items: [{ id: "att-1", filename: "logo.png", contentType: "image/png", sizeBytes: PNG.length, inline: true, contentId: "logo@corp", messageId: "m1" }],
    });
  }
  if (url.endsWith("/attachments/att-1")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  return json(404, { error: { code: "not_found", message: "not in the stand-in" } });
}

describe("the phone's embedded pictures", () => {
  it("are data: URIs of the part's own bytes, never a blob: its WebView cannot read", async () => {
    const boot = await bootEngine(
      { openExecutor: () => memoryExecutor(), deleteDatabase: async () => undefined, uuid: () => crypto.randomUUID(), fetch: (url) => phoneServer(String(url)) },
      { origin: "http://phone-pin.test", token: "tok-pin", accountId: "acct-pin" },
    );
    if (boot.kind !== "ready") throw new Error(`the boot did not reach ready: ${boot.kind}`);
    await boot.engine.loadInlineImages("m1", ["logo@corp"]);
    expect(boot.engine.inlineImagesOf("m1").get("logo@corp"))
      .toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    boot.engine.releaseAttachments("m1");
    boot.store.close();
  });
});
