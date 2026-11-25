import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { taggedIdentity } from "../../apps/mobile/scripts/release-identity.mjs";
import { assertAndroidIdentity, readAndroidArtifact } from "./android-artifact.mjs";

const oauth = "https://oauth2.googleapis.com/token";
const publisher = "https://androidpublisher.googleapis.com";
const internal = "internal";
const commitOptions = "?changesInReviewBehavior=ERROR_IF_IN_REVIEW";

class PlayError extends Error {}

async function request(operation, url, options) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
      ...options,
    });
  } catch {
    throw new PlayError(operation + " failed to reach the API.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlayError(operation + " failed (HTTP " + response.status + ").");
  }
  try {
    return await response.json();
  } catch {
    throw new PlayError(operation + " returned an invalid response.");
  }
}

async function accessToken(credentials, tokenUrl) {
  let assertion;
  try {
    const { client_email, private_key, private_key_id } = credentials;
    if (!client_email || !private_key) throw new Error();
    const iat = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "RS256", typ: "JWT", kid: private_key_id });
    const claims = encode({
      iss: client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    });
    const message = header + "." + claims;
    assertion = message + "." + sign("RSA-SHA256", Buffer.from(message), private_key).toString("base64url");
  } catch {
    throw new PlayError("Could not sign the Play OAuth assertion. Check the service account key.");
  }
  const token = await request("OAuth token exchange", tokenUrl, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (typeof token?.access_token !== "string" || !token.access_token) {
    throw new PlayError("The Play OAuth response did not contain an access token.");
  }
  return token.access_token;
}

function dryRunOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PlayError("Dry runs require a loopback HTTP origin.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.href !== url.origin + "/") {
    throw new PlayError("Dry runs require a loopback HTTP origin.");
  }
  return url.origin;
}

function serviceAccount() {
  try {
    return JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new PlayError("PLAY_SERVICE_ACCOUNT_JSON is invalid JSON.");
  }
}

async function main(args) {
  const dryRun = args[0] === "--dry-run";
  const origin = dryRun ? dryRunOrigin(args[1]) : publisher;
  const [command, targetPackage, target, tag, ...rest] = dryRun ? args.slice(2) : args;
  const promote = command === "promote";
  const [fraction, replace] = promote ? rest : [];
  const replaceStaged = replace === "--replace-staged";
  if (targetPackage !== "app.ohmail" && targetPackage !== "app.ohcal") {
    throw new PlayError("Use the app.ohmail or app.ohcal package.");
  }
  if (!target || !tag || (promote ? !fraction || (replace && !replaceStaged) || rest.length > 2
      : command !== "upload" || rest.length !== 2)) {
    throw new PlayError("Use upload <package> <bundle.aab> <tag> <bundletool jar> <digest> or promote <package> <version-code> <tag> <fraction> [--replace-staged].");
  }
  let identity;
  try {
    identity = taggedIdentity("android", tag);
  } catch {
    throw new PlayError("The Play release tag does not match the Expo release identity.");
  }
  if (targetPackage !== identity.androidPackage) throw new PlayError("Play target package does not match the release tag.");
  let bundle;
  let packageName = identity.androidPackage;
  if (!promote) {
    const [tool, digest] = rest;
    if (!target.endsWith(".aab") || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new PlayError("Use a signed App Bundle and its verified SHA-256 digest.");
    }
    bundle = await openAsBlob(target, { type: "application/octet-stream" });
    const hash = createHash("sha256");
    for await (const chunk of bundle.stream()) hash.update(chunk);
    if (hash.digest("hex") !== digest) throw new PlayError("The signed App Bundle digest differs.");
    let parsed;
    try {
      parsed = readAndroidArtifact(target, tool);
    } catch {
      throw new PlayError("Could not parse the signed App Bundle manifest.");
    }
    try {
      packageName = assertAndroidIdentity(parsed, identity).package;
    } catch (error) {
      throw new PlayError(error.message);
    }
  }
  const edits = "/androidpublisher/v3/applications/" + packageName + "/edits";
  if (!dryRun && !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
    console.log("::notice::Google Play skipped because PLAY_SERVICE_ACCOUNT_JSON is unset.");
    return;
  }

  const userFraction = Number(fraction);
  if (promote && (!/^[1-9]\d*$/.test(target) || !/^0\.\d+$/.test(fraction) || !(userFraction > 0 && userFraction < 1))) {
    throw new PlayError("Supply a positive Play version code and a rollout fraction between 0 and 1.");
  }
  const notesFile = identity.app === "ohcal" ? "../ohcal-play-release-notes.json" : "../play-release-notes.json";
  const releaseNotes = JSON.parse(await readFile(new URL(notesFile, import.meta.url), "utf8"));
  if (!Array.isArray(releaseNotes) || releaseNotes.length !== 2
      || !["en-US", "de-DE"].every((language) => releaseNotes.some((note) => note.language === language
        && typeof note.text === "string" && note.text.trim() && Array.from(note.text).length <= 500))) {
    throw new PlayError("Provide nonempty en-US and de-DE release notes, at most 500 characters each.");
  }

  const credentials = dryRun ? {
    client_email: "dry-run@example.invalid",
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
  } : serviceAccount();
  const token = await accessToken(credentials, dryRun ? origin + "/token" : oauth);
  const api = (operation, method, path, body, type) => request(operation, origin + path, {
    method,
    body,
    headers: { Authorization: "Bearer " + token, ...(type && { "Content-Type": type }) },
  });

  const edit = await api("edits.insert", "POST", edits, "{}", "application/json");
  if (typeof edit?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(edit.id)) {
    throw new PlayError("edits.insert did not return a valid edit ID.");
  }
  const path = edits + "/" + edit.id;
  let versionCode = target;
  let previous = [];
  let replacedVersionCodes;
  const track = promote ? "production" : internal;
  if (promote) {
    const tested = await api("tracks.get (internal)", "GET", path + "/tracks/" + internal);
    if (!tested.releases?.some((release) => release.status === "completed" && release.versionCodes?.includes(versionCode))) {
      throw new PlayError("That version code is not active on internal testing.");
    }
    const production = await api("tracks.get (production)", "GET", path + "/tracks/production");
    previous = production.releases ?? [];
    if (previous.length === 0) {
      throw new PlayError("Submit the first production release in Play Console before using staged rollout.");
    }
    const requestedCode = BigInt(versionCode);
    for (const { versionCodes } of previous) {
      if (!Array.isArray(versionCodes) || !versionCodes.length
          || versionCodes.some((code) => typeof code !== "string" || !/^[1-9]\d*$/.test(code))) {
        throw new PlayError("Could not verify production version codes. Check Play Console.");
      }
      if (versionCodes.some((code) => BigInt(code) >= requestedCode)) {
        throw new PlayError("Production already contains the same or a newer version. Check Play Console.");
      }
    }
    const unfinished = previous.filter((release) => release.status !== "completed");
    if (replaceStaged && unfinished.length === 1 && unfinished[0].status === "inProgress") {
      replacedVersionCodes = unfinished[0].versionCodes;
      previous = previous.filter((release) => release.status === "completed");
    } else if (unfinished.length) {
      throw new PlayError("Production has an unfinished release. Check Play Console.");
    }
  } else {
    const uploaded = await api("bundles.upload", "POST",
      "/upload" + path + "/bundles?uploadType=media", bundle, "application/octet-stream");
    if (String(uploaded?.versionCode) !== identity.androidVersionCode) {
      throw new PlayError("Play returned a version code that differs from the signed App Bundle.");
    }
    versionCode = identity.androidVersionCode;
  }

  const release = {
    versionCodes: [versionCode],
    releaseNotes,
    ...(promote ? { status: "inProgress", userFraction } : { status: "completed" }),
  };
  await api("tracks.update", "PUT", path + "/tracks/" + track,
    JSON.stringify({ track, releases: [...previous, release] }), "application/json");
  await api("edits.commit", "POST", path + ":commit" + commitOptions);
  console.log((dryRun ? "Dry run: " : "") + "Play committed Android version " + versionCode
    + (promote ? " to production at " + userFraction * 100 + "%." : " to internal testing."));
  if (replacedVersionCodes) {
    console.log("Replaced the staged production rollout for version codes " + replacedVersionCodes.join(", ") + ".");
  }
}

main(process.argv.slice(2)).catch((error) => {
  // Neither response bodies nor unexpected exception details belong in a credentialed job's log.
  console.error(error instanceof PlayError ? error.message : "Google Play release failed. Check the local inputs and Play Console.");
  process.exitCode = 1;
});
