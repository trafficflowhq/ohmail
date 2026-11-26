import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const LOOPBACK = "127.0.0.1";
export const FIXTURE_PROXY_PORT = 46241;

export function nextCli(webapp) {
  const require = createRequire(join(webapp, "package.json"));
  return join(dirname(require.resolve("next/package.json")), "dist/bin/next");
}

export async function buildEnvironment(
  state,
  { web = false, revision, proxyPort = FIXTURE_PROXY_PORT } = {},
) {
  const home = join(state, "build-home");
  const temp = join(state, "build-tmp");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temp, { recursive: true })]);
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    LANG: "C.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=4096",
    CIRCLE_NODE_TOTAL: "3",
    RAYON_NUM_THREADS: "2",
    UV_THREADPOOL_SIZE: "2",
    NEXT_TELEMETRY_DISABLED: "1",
    npm_config_offline: "true",
    HTTP_PROXY: `http://${LOOPBACK}:9`,
    HTTPS_PROXY: `http://${LOOPBACK}:9`,
    NO_PROXY: LOOPBACK,
    ...(revision ? { TF_BUILD_VERSION: revision } : {}),
    ...(web
      ? {
          TF_API_ORIGIN: `http://${LOOPBACK}:${proxyPort}`,
          NEXT_PUBLIC_GITHUB_STARS: "1",
        }
      : {}),
  };
}

export function spawnLogged(args, { cwd, env, log }) {
  const output = createWriteStream(log, { mode: 0o600 });
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const input of [child.stdout, child.stderr]) {
    createInterface({ input, terminal: false }).on("line", (line) => {
      if (
        /\b(?:authorization|(?:set-)?cookie|password|(?:access|refresh|session)[-_ ]?token)\s*[:=]/i.test(
          line,
        )
      )
        return;
      output.write(
        `${line
          .replace(/\b(?:https?|wss?):\/\/[^\s<>]+/gi, "[origin redacted]")
          .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?::\d+)?/g, "[address redacted]")
          .replace(/\b[^\s<>@]+@(?:[^\s<>@.]+\.)+[^\s<>@.]+/g, "[mailbox redacted]")}\n`,
      );
    });
  }
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => output.end(() => resolve({ code, signal })));
    output.once("error", reject);
  });
  // The caller may first wait for readiness, then inspect the process result.
  done.catch(() => {});
  return { child, done };
}

async function buildOne(runtime, state, surface, revision, proxyPort) {
  const web = surface === "web";
  const root = join(runtime, "apps", web ? "webapp" : "desktop");
  const manifest = join(root, web ? ".next/BUILD_ID" : "dist/index.html");
  const fingerprint = createHash("sha256")
    .update(await readFile(join(runtime, "package-lock.json")))
    .update(web ? String(proxyPort) : await readFile(join(root, "package-lock.json")))
    .update(`${surface}:${revision}`)
    .digest("hex");
  const receipt = join(state, `${surface}-build-fingerprint`);
  const stamp = await readFile(receipt, "utf8").catch(() => null);
  if (stamp === fingerprint && (await readFile(manifest).catch(() => null))) return;

  const log = join(state, `${surface}-build.log`);
  const args = web ? [nextCli(root), "build"] : ["scripts/build-ui.mjs", "--engine"];
  const { done } = spawnLogged(args, {
    cwd: root,
    env: await buildEnvironment(state, { web, revision, proxyPort }),
    log,
  });
  if ((await done).code !== 0) throw new Error(`The ${surface} production build failed. See ${log}`);
  if (
    web &&
    /Attempted import error:|\bexport '[^']*' (?:\((?:imported|reexported) as '[^']*'\) )?was not found in\b|\bis not exported from '/.test(
      await readFile(log, "utf8"),
    )
  ) {
    throw new Error(`The web production build has an unresolved import. See ${log}`);
  }
  await readFile(manifest);
  await writeFile(receipt, fingerprint, { mode: 0o600 });
}

export async function buildSurfaces({
  runtime,
  state,
  surfaces = ["web", "desktop"],
  revision,
  proxyPort = FIXTURE_PROXY_PORT,
}) {
  if (!revision) throw new Error("The runtime revision is required to reuse production builds.");
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)
    throw new Error("Invalid fixture proxy port.");
  runtime = resolve(runtime);
  state = resolve(state);
  await mkdir(state, { recursive: true });
  for (const surface of surfaces) {
    if (surface !== "web" && surface !== "desktop") throw new Error(`Unknown surface ${surface}.`);
    await buildOne(runtime, state, surface, revision, proxyPort);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [runtime, state, revision, ...surfaces] = process.argv.slice(2);
  if (!runtime || !state || !revision)
    throw new Error("Pass runtime directory, state directory and source revision.");
  const portFlag = surfaces.indexOf("--proxy-port");
  const proxyPort = portFlag < 0 ? FIXTURE_PROXY_PORT : Number(surfaces.splice(portFlag, 2)[1]);
  await buildSurfaces({
    runtime,
    state,
    revision,
    proxyPort,
    surfaces: surfaces.length ? surfaces : undefined,
  });
}
