import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../.github/scripts/play-upload.mjs", import.meta.url));
const notes = JSON.parse(await readFile(new URL("../.github/play-release-notes.json", import.meta.url), "utf8"));
const fixture = fileURLToPath(new URL("../.github/play-release-notes.json", import.meta.url));
const api = "/androidpublisher/v3/applications/app.ohmail/edits";
const commit = api + "/test-edit:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW";
const dummySecret = "dry-run-must-ignore-this-service-account";
const dummyToken = "fake-server-token";

const productionRead = [
  "POST /token", "POST " + api, "GET " + api + "/test-edit/tracks/internal",
  "GET " + api + "/test-edit/tracks/production",
];
const productionUpdate = "PUT " + api + "/test-edit/tracks/production";
const stagedProduction = [
  { status: "completed", versionCodes: ["120"] },
  { status: "inProgress", versionCodes: ["122"], userFraction: 0.99 },
];
const replaceArgs = ["promote", "123", "0.05", "--replace-staged"];

async function run(t, args, { failUpload = false, inReview = false, production = [], retained = production } = {}) {
  const calls = [];
  let assertion;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const route = request.method + " " + request.url;
      calls.push(route);
      response.setHeader("content-type", "application/json");
      let result;
      if (route === "POST /token") {
        assertion = new URLSearchParams(body).get("assertion");
        const [header, claims, signature] = assertion.split(".");
        assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
        const payload = JSON.parse(Buffer.from(claims, "base64url"));
        assert.equal(payload.scope, "https://www.googleapis.com/auth/androidpublisher");
        assert.ok(signature.length > 0);
        assert.ok(!body.includes(dummySecret));
        result = { access_token: dummyToken };
      } else {
        assert.equal(request.headers.authorization, "Bearer " + dummyToken);
        switch (route) {
          case "POST " + api:
            result = { id: "test-edit" };
            break;
          case "POST /upload" + api + "/test-edit/bundles?uploadType=media":
            assert.equal(request.headers["content-type"], "application/octet-stream");
            assert.equal(body, await readFile(fixture, "utf8"));
            if (failUpload) response.statusCode = 403;
            result = failUpload ? { error: { message: dummyToken + " " + assertion } } : { versionCode: 123 };
            break;
          case "GET " + api + "/test-edit/tracks/internal":
            result = { releases: [{ versionCodes: ["123"], status: "completed" }] };
            break;
          case "GET " + api + "/test-edit/tracks/production":
            result = { releases: production };
            break;
          case "PUT " + api + "/test-edit/tracks/internal":
            assert.deepEqual(JSON.parse(body), {
              track: "internal",
              releases: [{ versionCodes: ["123"], releaseNotes: notes, status: "completed" }],
            });
            break;
          case "PUT " + api + "/test-edit/tracks/production":
            assert.deepEqual(JSON.parse(body), {
              track: "production",
              releases: [...retained, { versionCodes: ["123"], releaseNotes: notes, status: "inProgress", userFraction: 0.05 }],
            });
            break;
          case "POST " + commit:
            assert.equal(body, "");
            if (inReview) response.statusCode = 400;
            break;
          default:
            assert.fail("Unexpected fake API request");
        }
      }
      response.end(JSON.stringify(result ?? {}));
    } catch {
      response.writeHead(500).end("{}");
    }
  });
  t.after(() => server.close());
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const url = "http://127.0.0.1:" + server.address().port;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [script, "--dry-run", url, ...args], {
      env: { PLAY_SERVICE_ACCOUNT_JSON: dummySecret },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr }));
  });
  for (const value of [dummySecret, dummyToken, assertion].filter(Boolean)) {
    assert.equal(result.output.includes(value), false, "CLI output disclosed credential material");
  }
  return { ...result, calls };
}

test("uploads a signed bundle to internal testing in a single edit", async (t) => {
  const result = await run(t, ["upload", fixture]);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, [
    "POST /token", "POST " + api, "POST /upload" + api + "/test-edit/bundles?uploadType=media",
    "PUT " + api + "/test-edit/tracks/internal", "POST " + commit,
  ]);
});

test("promotes an internal version without uploading a bundle or dropping production", async (t) => {
  const production = [{ status: "completed", versionCodes: ["120"] }];
  const result = await run(t, ["promote", "123", "0.05"], { production });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, [
    "POST /token", "POST " + api, "GET " + api + "/test-edit/tracks/internal",
    "GET " + api + "/test-edit/tracks/production", "PUT " + api + "/test-edit/tracks/production", "POST " + commit,
  ]);
});

test("replaces an older 99% production rollout when explicitly requested", async (t) => {
  const result = await run(t, replaceArgs, { production: stagedProduction, retained: [stagedProduction[0]] });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, [...productionRead, productionUpdate, "POST " + commit]);
  assert.match(result.output, /replaced.*122/i);
});

test("leaves an older staged rollout alone by default", async (t) => {
  const result = await run(t, ["promote", "123", "0.05"], { production: stagedProduction });
  assert.equal(result.code, 1);
  assert.match(result.output, /unfinished release/);
  assert.deepEqual(result.calls, productionRead);
});

test("refuses to promote over the same or a newer production version", async (t) => {
  for (const fixture of [
    { status: "inProgress", versionCodes: ["122", "123"], userFraction: 0.99 },
    { status: "inProgress", versionCodes: ["1000"], userFraction: 0.99 },
    { status: "completed", versionCodes: ["1000"] },
  ]) {
    const result = await run(t, replaceArgs, { production: [fixture] });
    assert.equal(result.code, 1);
    assert.match(result.output, /same or a newer version/);
    assert.deepEqual(result.calls, productionRead);
  }
});

test("refuses to replace a halted production release", async (t) => {
  const production = [{ status: "halted", versionCodes: ["122"] }];
  const result = await run(t, replaceArgs, { production });
  assert.equal(result.code, 1);
  assert.match(result.output, /unfinished release/);
  assert.deepEqual(result.calls, productionRead);
});

test("refuses to commit a replacement when Play has changes in review", async (t) => {
  const result = await run(t, replaceArgs, { production: stagedProduction, retained: [stagedProduction[0]], inReview: true });
  assert.equal(result.code, 1);
  assert.match(result.output, /edits\.commit.*HTTP 400/);
  assert.doesNotMatch(result.output, /replaced/i);
  assert.deepEqual(result.calls, [...productionRead, productionUpdate, "POST " + commit]);
});

test("stops after a failed bundle upload and keeps the error body out of the log", async (t) => {
  const result = await run(t, ["upload", fixture], { failUpload: true });
  assert.equal(result.code, 1);
  assert.match(result.output, /bundles\.upload.*HTTP 403/);
  assert.deepEqual(result.calls, ["POST /token", "POST " + api, "POST /upload" + api + "/test-edit/bundles?uploadType=media"]);
});

test("refuses a staged first production release and an invalid rollout fraction", async (t) => {
  const firstRelease = await run(t, ["promote", "123", "0.05"]);
  assert.equal(firstRelease.code, 1);
  assert.match(firstRelease.output, /first production release/);
  assert.deepEqual(firstRelease.calls, [
    "POST /token", "POST " + api, "GET " + api + "/test-edit/tracks/internal", "GET " + api + "/test-edit/tracks/production",
  ]);
  const invalid = await run(t, ["promote", "123", "1"]);
  assert.equal(invalid.code, 1);
  assert.deepEqual(invalid.calls, []);
});
