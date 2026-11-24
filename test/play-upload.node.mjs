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

async function run(t, args, { failUpload = false, production = [] } = {}) {
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
          case "GET " + api + "/test-edit/tracks/qa":
            result = { releases: [{ versionCodes: ["123"], status: "completed" }] };
            break;
          case "GET " + api + "/test-edit/tracks/production":
            result = { releases: production };
            break;
          case "PUT " + api + "/test-edit/tracks/qa":
            assert.deepEqual(JSON.parse(body), {
              track: "qa",
              releases: [{ versionCodes: ["123"], releaseNotes: notes, status: "completed" }],
            });
            break;
          case "PUT " + api + "/test-edit/tracks/production":
            assert.deepEqual(JSON.parse(body), {
              track: "production",
              releases: [...production, { versionCodes: ["123"], releaseNotes: notes, status: "inProgress", userFraction: 0.05 }],
            });
            break;
          case "POST " + commit:
            assert.equal(body, "");
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
    "PUT " + api + "/test-edit/tracks/qa", "POST " + commit,
  ]);
});

test("promotes an internal version without uploading a bundle or dropping production", async (t) => {
  const production = [{ status: "completed", versionCodes: ["120"] }];
  const result = await run(t, ["promote", "123", "0.05"], { production });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, [
    "POST /token", "POST " + api, "GET " + api + "/test-edit/tracks/qa",
    "GET " + api + "/test-edit/tracks/production", "PUT " + api + "/test-edit/tracks/production", "POST " + commit,
  ]);
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
    "POST /token", "POST " + api, "GET " + api + "/test-edit/tracks/qa", "GET " + api + "/test-edit/tracks/production",
  ]);
  const invalid = await run(t, ["promote", "123", "1"]);
  assert.equal(invalid.code, 1);
  assert.deepEqual(invalid.calls, []);
});
