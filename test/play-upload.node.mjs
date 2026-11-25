import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseIdentity } from "../apps/mobile/scripts/release-identity.mjs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../.github/scripts/play-upload.mjs", import.meta.url));
const notes = JSON.parse(await readFile(new URL("../.github/play-release-notes.json", import.meta.url), "utf8"));
const mail = releaseIdentity("ohmail");
const calendar = releaseIdentity("ohcal");
const mailTag = "android-v" + mail.version;
const calendarTag = "ohcal-android-v" + calendar.version;
const fixture = await readFile(new URL("../.github/play-release-notes.json", import.meta.url), "utf8");
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
const promote = (fraction = "0.05", ...options) => ["promote", "app.ohmail", "123", mailTag, fraction, ...options];
const replaceArgs = promote("0.05", "--replace-staged");
const upload = (pkg = "app.ohmail", tag = mailTag) => ["upload", pkg, "bundle.aab", tag, "bundletool.jar"];

async function run(t, args, {
  failUpload = false, inReview = false, production = [], retained = production, artifact = mail,
  target = mail, uploadedCode = Number(target.androidVersionCode),
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "play-upload-"));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "bundle.aab"), fixture);
  const digest = createHash("sha256").update(fixture).digest("hex");
  const api = "/androidpublisher/v3/applications/" + target.androidPackage + "/edits";
  const commit = api + "/test-edit:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW";
  const internalNotes = target.app === "ohcal"
    ? JSON.parse(await readFile(new URL("../.github/ohcal-play-release-notes.json", import.meta.url), "utf8"))
    : notes;
  await writeFile(join(dir, "java"), `#!/bin/sh
case "$*" in
  *'@package') echo '${artifact.androidPackage}' ;;
  *'@android:versionCode') echo '${artifact.androidVersionCode}' ;;
  *'@android:versionName') echo '${artifact.version}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  if (args[0] === "upload") args = [...args, digest];
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
            assert.equal(body, fixture);
            if (failUpload) response.statusCode = 403;
            result = failUpload ? { error: { message: dummyToken + " " + assertion } } : { versionCode: uploadedCode };
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
              releases: [{ versionCodes: [target.androidVersionCode], releaseNotes: internalNotes, status: "completed" }],
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
      cwd: dir,
      env: { PATH: dir, PLAY_SERVICE_ACCOUNT_JSON: dummySecret },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr }));
  });
  for (const value of [dummySecret, dummyToken, assertion].filter(Boolean)) {
    assert.equal(result.output.includes(value), false, "CLI output disclosed credential material");
  }
  return { ...result, calls };
}

test("uploads a signed bundle to internal testing in a single edit", async (t) => {
  const result = await run(t, upload());
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, [
    "POST /token", "POST " + api, "POST /upload" + api + "/test-edit/bundles?uploadType=media",
    "PUT " + api + "/test-edit/tracks/internal", "POST " + commit,
  ]);
});

test("promotes an internal version without uploading a bundle or dropping production", async (t) => {
  const production = [{ status: "completed", versionCodes: ["120"] }];
  const result = await run(t, promote(), { production });
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
  const result = await run(t, promote(), { production: stagedProduction });
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
  const result = await run(t, upload(), { failUpload: true });
  assert.equal(result.code, 1);
  assert.match(result.output, /bundles\.upload.*HTTP 403/);
  assert.deepEqual(result.calls, ["POST /token", "POST " + api, "POST /upload" + api + "/test-edit/bundles?uploadType=media"]);
});

test("refuses a staged first production release and an invalid rollout fraction", async (t) => {
  const firstRelease = await run(t, promote());
  assert.equal(firstRelease.code, 1);
  assert.match(firstRelease.output, /first production release/);
  assert.deepEqual(firstRelease.calls, [
    "POST /token", "POST " + api, "GET " + api + "/test-edit/tracks/internal", "GET " + api + "/test-edit/tracks/production",
  ]);
  const invalid = await run(t, promote("1"));
  assert.equal(invalid.code, 1);
  assert.deepEqual(invalid.calls, []);
});

test("refuses a crossed upload package before opening an edit", async (t) => {
  const result = await run(t, upload("app.ohcal", calendarTag));
  assert.equal(result.code, 1);
  assert.match(result.output, /artifact package/);
  assert.deepEqual(result.calls, []);
});

test("refuses either app's promotion on its sibling's tag before opening an edit", async (t) => {
  for (const [pkg, tag] of [["app.ohcal", mailTag], ["app.ohmail", calendarTag]]) {
    const result = await run(t, ["promote", pkg, mail.androidVersionCode, tag, "0.05"]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Play target package does not match the release tag/);
    assert.deepEqual(result.calls, []);
  }
});

test("refuses an unrecognized upload package before opening an edit", async (t) => {
  const result = await run(t, upload("app.evil"));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Use the app.ohmail or app.ohcal package/);
  assert.deepEqual(result.calls, []);
});

test("an ohcal bundle opens only the ohcal edit", async (t) => {
  const result = await run(t, upload("app.ohcal", calendarTag), { artifact: calendar, target: calendar });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.calls.slice(1).every((call) => call.includes("/applications/app.ohcal/")));
});

test("refuses a correctly named bundle with a wrong version before opening an edit", async (t) => {
  const result = await run(t, upload(), { artifact: { ...mail, version: "1.0.01" } });
  assert.equal(result.code, 1);
  assert.match(result.output, /artifact version name/);
  assert.deepEqual(result.calls, []);
});

test("refuses an upload version that Play reads differently before updating the track", async (t) => {
  const result = await run(t, upload(), { uploadedCode: Number(mail.androidVersionCode) + 1 });
  assert.equal(result.code, 1);
  assert.match(result.output, /Play returned a version code/);
  assert.deepEqual(result.calls, ["POST /token", "POST " + api, "POST /upload" + api + "/test-edit/bundles?uploadType=media"]);
});
