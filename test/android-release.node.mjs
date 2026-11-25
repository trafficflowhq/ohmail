import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { releaseIdentity } from "../apps/mobile/scripts/release-identity.mjs";
import { test } from "node:test";

const cli = (script, ...args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
};
const release = "apps/mobile/scripts/release-identity.mjs";
const artifact = ".github/scripts/android-artifact.mjs";
const page = ".github/scripts/check-release-page.mjs";
const mail = releaseIdentity("ohmail");
const { load } = createRequire(import.meta.url)("js-yaml");
const { jobs } = load(readFileSync(".github/workflows/android.yml", "utf8"));
const workflowStep = (job, name) => {
  const step = jobs[job].steps.find((candidate) => candidate.name === name);
  assert.ok(step?.run, name);
  return step.run;
};
const run = (command, args, cwd, values = {}) => spawnSync(command, args, {
  cwd, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), ...values }, encoding: "utf8",
});
const bash = (script, cwd, values) => run("bash", ["-c", script], cwd, values);
const ok = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
const writeTool = (file, body) => writeFileSync(file, "#!/bin/sh\nset -eu\n" + body, { mode: 0o755 });
const identityStep = () => workflowStep("build", "The tag matches the app's own version");

function fixture(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true }));
  return dir;
}

function copyReleaseConfig(dir) {
  for (const file of ["app.json", "app.config.js", "variant-config.js", "variants.json", "scripts/release-identity.mjs"]) {
    cpSync("apps/mobile/" + file, join(dir, "apps/mobile", file));
  }
}

test("the ohcal tag inherits both mail store numbers and rejects an unrelated version", () => {
  const valid = cli(release, "android-tag", "ohcal-android-v" + mail.version);
  assert.equal(valid.status, 0, valid.err);
  const identity = JSON.parse(valid.out);
  assert.deepEqual(
    [identity.androidPackage, identity.iosBundleId, identity.version, identity.androidVersionCode, identity.iosBuildNumber],
    ["app.ohcal", "app.ohcal", mail.version, mail.androidVersionCode, mail.iosBuildNumber],
  );
  const wrong = cli(release, "android-tag", "ohcal-android-v" + mail.version + "1");
  assert.equal(wrong.status, 1);
  assert.match(wrong.err, /does not match/);
});

test("CI parses every GitHub shell script and refuses a malformed one", (t) => {
  const { jobs: ci } = load(readFileSync(".github/workflows/ci.yml", "utf8"));
  const check = ci.typecheck.steps.find((step) => step.name === "Parse GitHub shell scripts");
  assert.ok(check?.run);
  ok(bash(check.run, "."));
  const dir = fixture(t, "github-syntax-");
  mkdirSync(join(dir, ".github/scripts"), { recursive: true });
  writeFileSync(join(dir, ".github/scripts/broken.sh"), "if true; then\n");
  writeFileSync(join(dir, ".github/scripts/valid.sh"), "true\n");
  const result = bash(check.run, dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broken\.sh/);
});

test("the parsed package is exact even when the sibling is named in the output", async () => {
  const { assertAndroidIdentity, parseApkBadging } = await import("../" + artifact);
  const expected = { androidPackage: "app.ohmail", androidVersionCode: "1", version: "1.0.0" };
  const crossed = parseApkBadging("package: name='app.ohcal' versionCode='1' versionName='1.0.0'\n"
    + "uses-permission: name='app.ohmail.permission.SWITCH'\n");
  assert.throws(() => assertAndroidIdentity(crossed, expected), /package/);
  const wrongCode = { ...crossed, package: "app.ohmail", versionCode: "2" };
  assert.throws(() => assertAndroidIdentity(wrongCode, expected), /version code/);
  const wrongVersion = { ...wrongCode, versionCode: "1", versionName: "1.0.01" };
  assert.throws(() => assertAndroidIdentity(wrongVersion, expected), /version name/);
});

test("an ohcal release page marked Latest is refused even if it is a prerelease", () => {
  const latest = cli(page, "ohcal-android-v1.0.0", "true", "ohcal-android-v1.0.0");
  assert.equal(latest.status, 1);
  assert.match(latest.err, /Latest/);
  const ordinary = cli(page, "ohcal-ios-v1.0.0", "false", "v2.0.6");
  assert.equal(ordinary.status, 1);
  assert.match(ordinary.err, /prerelease/);
  assert.equal(cli(page, "ohcal-ios-v1.0.0", "true", "v2.0.6").status, 0);
});


test("the Android workflow's ohmail tag step selects the existing mail build", (t) => {
  const dir = fixture(t, "android-tag-");
  const output = join(dir, "output");
  const exported = join(dir, "variant");
  ok(bash(identityStep(), ".", {
    GITHUB_REF_NAME: "android-v" + mail.version,
    GITHUB_OUTPUT: output,
    GITHUB_ENV: exported,
  }));
  assert.equal(readFileSync(output, "utf8"), "app=ohmail\n");
  assert.equal(readFileSync(exported, "utf8"), "OHMAIL_VARIANT=ohmail\n");
});

test("the calendar Android tag must be a main merge at the matching ohmail tag", (t) => {
  const dir = fixture(t, "calendar-tag-");
  copyReleaseConfig(dir);
  const git = (...args) => ok(run("git", args, dir, {
    GIT_AUTHOR_NAME: "Release Fixture", GIT_AUTHOR_EMAIL: "release@example.test",
    GIT_COMMITTER_NAME: "Release Fixture", GIT_COMMITTER_EMAIL: "release@example.test",
  }));
  git("init", "-qb", "main");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "main input");
  const initial = git("rev-parse", "HEAD");
  git("switch", "-qc", "change");
  git("commit", "--allow-empty", "-qm", "changes");
  const side = git("rev-parse", "HEAD");
  const sideMerge = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", side, "-p", initial, "-m", "branch merge");
  git("update-ref", "refs/heads/change", sideMerge);
  git("switch", "-q", "main");
  git("merge", "--no-ff", "-qm", "promotion", "change");
  const merged = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", merged);
  const mailTag = "v" + mail.version;
  const calendarTag = "ohcal-android-v" + mail.version;
  const check = (head, mailHead) => {
    git("checkout", "-q", "--detach", head);
    git("update-ref", "refs/tags/" + mailTag, mailHead);
    return bash(identityStep(), dir, {
      GITHUB_REF_NAME: calendarTag, GITHUB_OUTPUT: join(dir, "output"), GITHUB_ENV: join(dir, "variant"),
    });
  };
  ok(check(merged, merged));
  assert.notEqual(check(sideMerge, sideMerge).status, 0, "a merge outside the first-parent chain");
  assert.notEqual(check(initial, initial).status, 0, "a main commit without two parents");
  assert.notEqual(check(merged, initial).status, 0, "a main merge tagged at a different ohmail release");
});

test("the Android tag checks both fixture artifacts, verifies the APK and preserves the ohmail mapping", (t) => {
  const dir = fixture(t, "android-artifacts-");
  copyReleaseConfig(dir);
  const outputs = "apps/mobile/android/app/build/outputs";
  const apk = outputs + "/apk/release/app-release.apk";
  const aab = outputs + "/bundle/release/app-release.aab";
  const mapping = outputs + "/mapping/release/mapping.txt";
  for (const type of ["apk", "bundle", "mapping"]) mkdirSync(join(dir, outputs, type, "release"), { recursive: true });
  for (const file of [
    artifact, ".github/scripts/assert-no-fcm.sh", ".github/scripts/firebase-inert-allowlist.txt",
    "apps/mobile/scripts/assert-variant.mjs",
  ]) {
    cpSync(file, join(dir, file));
  }
  const manifest = "app.ohmail app.ohcal app.ohmail.permission.SWITCH .SwitchOpen app.ohmail.appswitch.SwitchProvider "
    + "app.ohmail.switch dev.djara.expounifiedpush.PAYLOAD_RENDERER app.ohmail.push.WakePayloadRenderer";
  const dex = "Lorg/unifiedpush/android/connector/Marker; Lapp/ohmail/push/WakePayloadRenderer;";
  ok(run("python3", ["-c", `
import sys, zipfile
for file in sys.argv[1:4]:
    with zipfile.ZipFile(file, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("AndroidManifest.xml", sys.argv[4] if file == sys.argv[1] else "calendar fixture")
        archive.writestr("classes.dex", "dex\\n035\\0" + (sys.argv[5] if file == sys.argv[1] else "") + "0" * 1000001)
        if file.endswith(".aab"):
            archive.writestr("META-INF/DEBUG.RSA", "debug fixture")
`, apk, aab, "calendar.apk", manifest, dex], dir));
  writeFileSync(join(dir, mapping), "Example -> a:\n");
  const tools = join(dir, "bin");
  const android = join(dir, "android-sdk");
  const buildTools = join(android, "build-tools", "35.0.0");
  mkdirSync(tools);
  mkdirSync(buildTools, { recursive: true });
  if (process.platform === "darwin") {
    writeTool(join(tools, "stat"), '[ "$1" = -c%s ]\nexec /usr/bin/stat -f %z "$2"\n');
  }
  writeTool(join(buildTools, "aapt2"), `
[ "$1" = dump ] && [ "$2" = badging ] && [ "\${3##*/}" = app-release.apk ] && [ -f "$3" ]
echo "package: name='app.ohmail' versionCode='${mail.androidVersionCode}' versionName='${mail.version}'"
`);
  writeTool(join(tools, "java"), `
[ "$1" = -jar ] && [ -f "$2" ] && [ "$3:$4" = dump:manifest ]
[ -f "\${5#--bundle=}" ] && [ "$6" = --module=base ]
case "$7" in
  --xpath=/manifest/@package) echo app.ohmail ;;
  --xpath=/manifest/@android:versionCode) echo '${mail.androidVersionCode}' ;;
  --xpath=/manifest/@android:versionName) echo '${mail.version}' ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(dir, "bundletool.jar"), "manifest tool fixture");
  const values = {
    PATH: tools + delimiter + process.env.PATH, ANDROID_HOME: android, RUNNER_TEMP: dir,
    OHMAIL_VARIANT: "ohmail", GITHUB_REF_NAME: "android-v" + mail.version,
  };
  const pushScan = jobs.build.steps.find((step) => step.name === "No Google push code in the binary");
  assert.match(ok(bash(pushScan.run, dir, values)), /manifest carries/);
  assert.match(ok(run("bash", [".github/scripts/assert-no-fcm.sh", "calendar.apk", "ohcal"], dir)), /OK/);
  assert.notEqual(run("bash", [".github/scripts/assert-no-fcm.sh", apk, "ohcal"], dir).status, 0);
  const artifactRead = workflowStep("build", "Read the APK and App Bundle package and versions");
  const [apkRead, aabRead, ...variantRead] = ok(bash(artifactRead, dir, values)).split("\n");
  const expected = { package: "app.ohmail", versionCode: mail.androidVersionCode, versionName: mail.version };
  assert.deepEqual(JSON.parse(apkRead), expected);
  assert.deepEqual(JSON.parse(aabRead), expected);
  assert.match(variantRead.join("\n"), /OK +package app\.ohmail/);
  ok(bash(workflowStep("build", "Compress the mapping for the release page"), dir, values));
  assert.equal(gunzipSync(readFileSync(join(dir, "ohmail-android-mapping.txt.gz"))).toString(), "Example -> a:\n");

  mkdirSync(join(dir, "unsigned"));
  mkdirSync(join(dir, "unsigned-bundle"));
  cpSync(join(dir, apk), join(dir, "unsigned", "app-release.apk"));
  cpSync(join(dir, aab), join(dir, "unsigned-bundle", "app-release.aab"));
  writeTool(join(buildTools, "apksigner"), `
[ "$1" = sign ] && [ "\${10}" = --out ]
cp "\${12}" "\${11}"
`);
  writeTool(join(tools, "jarsigner"), `
[ "$9" = -signedjar ]
cp "\${11}" "\${10}"
`);
  const sign = workflowStep("sign", "Sign the APK and the App Bundle with the release keystore");
  ok(bash(sign, dir, {
    ...values, JAVA_HOME: dir, RELEASE_APP: "ohmail",
    ANDROID_KEYSTORE_B64: Buffer.from("fixture").toString("base64"), ANDROID_KEY_ALIAS: "fixture",
  }));
  assert.ok(existsSync(join(dir, "ohmail-android.apk")));
  const names = ok(run("unzip", ["-Z1", "ohmail-android.aab"], dir));
  assert.doesNotMatch(names, /DEBUG\.RSA/);
});

test("the signing step refuses a crossed or missing app before reading signing inputs", (t) => {
  const dir = fixture(t, "android-sign-");
  const sign = workflowStep("sign", "Sign the APK and the App Bundle with the release keystore");
  for (const app of ["ohcal", ""]) {
    const result = bash(sign, dir, { RELEASE_APP: app, GITHUB_REF_NAME: "android-v" + mail.version, RUNNER_TEMP: dir });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /mismatched release app/);
  }
});

test("the calendar release-page guard refuses unsafe state and repairs published releases only when asked", (t) => {
  const dir = fixture(t, "github-release-page-");
  const script = ".github/scripts/check-ohcal-release-page.sh";
  const tag = "ohcal-android-v" + mail.version;
  const previous = "v" + mail.version;
  const calls = join(dir, "calls");
  writeTool(join(dir, "gh"), `
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'api repos/example/project/releases/tags/${tag}')
    case "$STATE" in
      no-page) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
      error) echo 'gh: Service Unavailable (HTTP 503)' >&2; exit 1 ;;
      ordinary|latest) echo false ;;
      *) echo true ;;
    esac ;;
  'api repos/example/project/releases/latest')
    if [ "$STATE" = latest ] && [ ! -f "$DEMOTED" ]; then
      echo '${tag}'
    elif [ "$STATE" = latest ] && [ ! -f "$RESTORED" ]; then
      echo 'gh: Not Found (HTTP 404)' >&2; exit 1
    else
      echo '${previous}'
    fi ;;
  'api repos/example/project/releases') echo '${previous}' ;;
  'release edit')
    if [ "$3:$4:$5" = '${tag}:--prerelease:--latest=false' ]; then
      touch "$DEMOTED"
    elif [ "$3:$4" = '${previous}:--latest' ]; then
      touch "$RESTORED"
    else
      exit 98
    fi ;;
  *) exit 99 ;;
esac
`);
  const check = (state, repair = false) => {
    writeFileSync(calls, "");
    const values = {
      PATH: dir + delimiter + process.env.PATH, CALLS: calls, STATE: state,
      DEMOTED: join(dir, "demoted-" + state), RESTORED: join(dir, "restored-" + state),
      GITHUB_REPOSITORY: "example/project",
    };
    const result = run("bash", [script, tag, ...(repair ? ["--repair"] : [])], ".", values);
    return { ...result, calls: readFileSync(calls, "utf8") };
  };
  for (const state of ["no-page", "safe"]) {
    const result = check(state, true);
    assert.equal(result.status, 0, state + "\n" + result.stderr + result.calls);
    assert.doesNotMatch(result.calls, /release edit/);
  }
  const error = check("error", true);
  assert.equal(error.status, 1, error.stdout);
  assert.doesNotMatch(error.calls, /release edit/);
  const readOnly = check("ordinary");
  assert.equal(readOnly.status, 1, readOnly.stdout);
  assert.doesNotMatch(readOnly.calls, /release edit/);
  const ordinary = check("ordinary", true);
  assert.equal(ordinary.status, 1, ordinary.stdout);
  assert.match(ordinary.calls, /release edit .* --prerelease --latest=false/);
  const latest = check("latest", true);
  assert.equal(latest.status, 1, latest.stdout);
  assert.ok(existsSync(join(dir, "demoted-latest")), latest.stderr);
  assert.ok(existsSync(join(dir, "restored-latest")), latest.stderr);
  assert.match(latest.stderr, /restored/i);
});

test("an ohcal iOS tag uses the shared build and refuses a different override", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ios-identity-"));
  t.after(() => rmSync(dir, { recursive: true }));
  for (const file of ["app.json", "app.config.js", "variant-config.js", "variants.json", "scripts/release-identity.mjs"]) {
    cpSync("apps/mobile/" + file, join(dir, file));
  }
  const appJson = join(dir, "app.json");
  const before = readFileSync(appJson);
  const copy = join(dir, "scripts/release-identity.mjs");
  const tag = "ohcal-ios-v" + mail.version;
  const variants = readFileSync(join(dir, "variants.json"));
  const overridden = cli(copy, "ios-tag", tag, mail.iosBuildNumber);
  assert.equal(overridden.status, 0, overridden.err);
  assert.equal(JSON.parse(overridden.out).iosBuildNumber, mail.iosBuildNumber);
  const wrong = cli(copy, "ios-tag", tag, String(Number(mail.iosBuildNumber) + 1));
  assert.equal(wrong.status, 1, wrong.out);
  assert.match(wrong.err, /shared iOS build/);
  assert.equal(cli(copy, "ios-tag", tag + "-b" + mail.iosBuildNumber).status, 1);
  assert.deepEqual(readFileSync(appJson), before);
  assert.deepEqual(readFileSync(join(dir, "variants.json")), variants);

  const mailOverride = String(Number(mail.iosBuildNumber) + 1);
  const result = cli(copy, "ios-tag", "v" + mail.version, mailOverride);
  assert.equal(result.status, 0, result.err);
  assert.equal(JSON.parse(result.out).iosBuildNumber, mailOverride);
  assert.equal(JSON.parse(cli(copy, "ios-tag", tag).out).iosBuildNumber, mailOverride);
});

test("both apps take the 2.0.7 release and its build from the same app.json", (t) => {
  const dir = fixture(t, "shared-release-");
  copyReleaseConfig(dir);
  const appJson = join(dir, "apps/mobile/app.json");
  const { expo } = JSON.parse(readFileSync(appJson));
  expo.version = "2.0.7";
  expo.android.versionCode = 131;
  expo.ios.buildNumber = "131";
  writeFileSync(appJson, JSON.stringify({ expo }));
  const script = join(dir, release);
  for (const [command, tag] of [
    ["ios-tag", "v2.0.7"], ["ios-tag", "ohcal-ios-v2.0.7"],
    ["android-tag", "android-v2.0.7"], ["android-tag", "ohcal-android-v2.0.7"],
  ]) {
    const result = cli(script, command, tag);
    assert.equal(result.status, 0, result.err);
    const { version, androidVersionCode, iosBuildNumber } = JSON.parse(result.out);
    assert.deepEqual([version, androidVersionCode, iosBuildNumber], ["2.0.7", "131", "131"]);
  }
});
