import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { inspect } from "node:util";
import { isTestAccountAddress, parseCalendarTestAccounts, readCalendarTestAccounts, Secret } from "../calendar-test-accounts.ts";

const INVENTED = ["# invented", "ICLOUD_APPLE_ID=Bench.Potter@icloud.example", "ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop", "GOOGLE_TEST_ACCOUNT=bench.kiln@gmail.example", "GOOGLE_OAUTH_CLIENT_ID=invented-client-id", "GOOGLE_OAUTH_CLIENT_SECRET=invented=client=secret", "GOOGLE_TEST_REFRESH_TOKEN=invented-refresh-token", "MS_TEST_ACCOUNT=", "export SHELLISH=no", 'QUOTED="kept as written"', ""].join("\n");

describe("Secret", () => {
  const s = new Secret("the-value-itself");
  it("prints as the redaction wherever a value could be shown", () => {
    assert.equal(String(s), "[secret]");
    assert.equal(`${s}`, "[secret]");
    assert.equal(JSON.stringify({ s }), '{"s":"[secret]"}');
    assert.equal(inspect(s), "[secret]");
    assert.equal(inspect({ nested: [s] }), "{ nested: [ [secret] ] }");
    assert.ok(!Object.keys(s).length && !inspect(s, { showHidden: true }).includes("the-value-itself"));
  });
  it("shows itself in an assertion's diff as the redaction", () => {
    const failure = (() => {
      try {
        assert.deepEqual({ token: s }, { token: "something else" });
      } catch (e) {
        return String((e as Error).message);
      }
      return "";
    })();
    assert.ok(failure.length > 0 && !failure.includes("the-value-itself"));
  });
  it("answers yes or no, and takes itself out of a text in every written form", () => {
    const address = new Secret("Bench.Potter@icloud.example");
    assert.ok(address.is("bench.potter@ICLOUD.example") && address.is(new Secret("bench.potter@icloud.example")) && !address.is("someone@icloud.example"));
    assert.ok(!new Secret("").is(""));
    const text = 'a Bench.Potter@icloud.example b bench.potter@icloud.example c Bench.Potter%40icloud.example d';
    assert.equal(address.redactIn(text, "X"), "a X b X c X d");
    assert.equal(new Secret('quo"te\\d-value').redactIn(JSON.stringify({ v: 'quo"te\\d-value' }), "X"), '{"v":"X"}');
    assert.equal(new Secret("abcd-efgh-ijkl-mnop").redactIn("joined abcdefghijklmnop", "X"), "joined X");
  });
  it("takes itself out of base64 too, wherever its first byte falls, with the letters around it", () => {
    for (const value of ["bench.potter@icloud.example", "bench.potters@icloud.example", "bench.potterss@icloud.example", "Bench.Potter@icloud.example"]) {
      for (const before of ["", "1", "26", "26#"]) {
        for (const encoding of ["base64", "base64url"] as const) {
          const carried = Buffer.from(`${before}${value.toLowerCase()}~~>?hash`, "utf8").toString(encoding);
          assert.equal(new Secret(value).redactIn(`a link?tok=${carried}&hl=en`, "X"), "a link?tok=X&hl=en", `${value.length} letters after ${before.length}, ${encoding}`);
        }
      }
    }
    assert.equal(new Secret("bench.potter@icloud.example").redactIn("YmVuY2gucG90dGVy is half of it, and stays", "X"), "YmVuY2gucG90dGVy is half of it, and stays");
  });
});

describe("the accounts file", () => {
  it("is never found by itself: no name, no file", () => {
    assert.throws(() => readCalendarTestAccounts({}), /no accounts file named/);
    assert.throws(() => readCalendarTestAccounts({ OHCAL_TEST_ACCOUNTS_FILE: "" }), /no accounts file named/);
  });
  it("is read by the one rule: KEY=value, no quotes, no export", () => {
    const a = parseCalendarTestAccounts(INVENTED);
    assert.ok(a.GOOGLE_OAUTH_CLIENT_SECRET.is("invented=client=secret"));
    assert.ok(a.ICLOUD_APPLE_ID.filled && !("SHELLISH" in a) && !("QUOTED" in a) && !("MS_TEST_ACCOUNT" in a));
  });
  it("reads the named file and says which key is empty, by name only", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohcal-accounts-"));
    const full = join(dir, "accounts");
    writeFileSync(full, INVENTED, { mode: 0o600 });
    assert.ok(readCalendarTestAccounts({ OHCAL_TEST_ACCOUNTS_FILE: full }).GOOGLE_TEST_ACCOUNT.is("bench.kiln@gmail.example"));
    const partial = join(dir, "partial");
    writeFileSync(partial, INVENTED.replace("GOOGLE_TEST_REFRESH_TOKEN=invented-refresh-token", "GOOGLE_TEST_REFRESH_TOKEN="), { mode: 0o600 });
    assert.throws(() => readCalendarTestAccounts({ OHCAL_TEST_ACCOUNTS_FILE: partial }), (e: Error) => e.message === "the accounts file leaves empty: GOOGLE_TEST_REFRESH_TOKEN");
    assert.throws(() => readCalendarTestAccounts({ OHCAL_TEST_ACCOUNTS_FILE: join(dir, "absent") }), /cannot be read \(ENOENT\)/);
  });
  it("knows the two addresses an invitation may name, and no third", () => {
    const a = parseCalendarTestAccounts(INVENTED);
    assert.ok(isTestAccountAddress(a, "bench.potter@icloud.example") && isTestAccountAddress(a, a.GOOGLE_TEST_ACCOUNT));
    assert.ok(!isTestAccountAddress(a, "mila@lichtgrat.example") && !isTestAccountAddress(a, "") && !isTestAccountAddress(a, new Secret("")));
  });
});
