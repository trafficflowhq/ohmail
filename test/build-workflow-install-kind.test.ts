import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * THE APPIMAGE JOB ASSERTS THE INSTALL KIND IT SHIPS.
 *
 * The updater knows a copy IS the AppImage by the live mount's FUSE subtype, the image's own file
 * name. A runtime that stopped writing it would make every AppImage `unpackaged`, which never
 * updates, with every other check green. The launch check runs the image extracted, where the kind
 * is `unpackaged` by design (measured on a 0.25 image: extracted `unpackaged`, mounted `appimage`),
 * so each Linux job runs it MOUNTED; here the step runs as the shell it is against stubs.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const wfText = readFileSync(publicPath("github/workflows/build.yml"), "utf8");
const wf = wfText.split("\n");
const STEP = "The mounted AppImage says it is an AppImage";

function jobLines(job: string): { from: number; to: number } {
  const from = wf.indexOf(`  ${job}:`);
  expect(from, `build.yml has no ${job} job`).toBeGreaterThan(-1);
  const to = wf.findIndex((l, i) => i > from && /^ {2}[a-z][a-z0-9-]*:$/.test(l));
  return { from, to: to === -1 ? wf.length : to };
}

/** The step's `run:` body in one job, dedented. */
function stepBody(job: string): string {
  const { from, to } = jobLines(job);
  const at = wf.findIndex((l, i) => i > from && i < to && l.trim() === `- name: ${STEP}`);
  expect(at, `the ${job} job has no "${STEP}" step`).toBeGreaterThan(-1);
  const runAt = wf.findIndex((l, i) => i > at && l.trim() === "run: |");
  const indent = wf[runAt].indexOf("run:") + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < to; i++) {
    if (wf[i].trim() !== "" && wf[i].search(/\S/) < indent) break;
    body.push(wf[i].slice(indent));
  }
  return `${body.join("\n")}\n`;
}

const AMD64 = stepBody("linux");
const ARM = stepBody("linux-arm64");
const FUSE_LINE = "test -c /dev/fuse ||";

const OFFER = (kind: string) => `{"service":"updater","event":"updater_offer","offered":"none","found":"upToDate","installKind":"${kind}"}`;

type World = {
  /** What the stub image writes to stderr: a kind to report, or a line of its own. */
  kind?: string;
  says?: string;
  /** The stub image exits with this, before writing anything, like a runtime that cannot mount. */
  exitEarly?: number;
  missingTool?: string;
  noFuse?: boolean;
  env?: Record<string, string>;
};
type Ran = { code: number; out: string; err: string; started: boolean; child: number };

function run(body: string, world: World = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-install-kind-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "build"));
  const tools: Record<string, string> = {
    Xvfb: "#!/usr/bin/env bash\nexec /bin/sleep 30\n",
    xwininfo: "#!/usr/bin/env bash\nexit 0\n",
    fusermount3: "#!/usr/bin/env bash\nexit 0\n",
    // Every wait in the step becomes a short one, so a poll that is not answered ends in seconds.
    sleep: "#!/usr/bin/env bash\nexec /bin/sleep 0.05\n",
  };
  for (const [name, text] of Object.entries(tools)) {
    if (name === world.missingTool) continue;
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  /* PATH is this directory alone, so a tool left out is ABSENT rather than found on the host: the
     host carries a real Xvfb and fusermount3, and a missing-tool arm read through them admits. */
  for (const tool of ["bash", "env", "setsid", "grep", "sed", "mkdir", "rm", "chmod", "tail", "seq", "cat"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    expect(found, `this host has no ${tool} for the harness`).not.toBe("");
    symlinkSync(found, join(bin, tool));
  }
  /* The image: it starts a child of its own (a runtime starts the app), then says what it is. A
     copy started with the extraction variable says `unpackaged`, as the real one does. */
  const emit = world.says ?? (world.kind ? OFFER(world.kind) : "");
  const image = [
    "#!/usr/bin/env bash",
    `echo started > "${join(dir, "started")}"`,
    world.exitEarly !== undefined ? `echo "Error: cannot mount the image; check your FUSE setup" >&2; exit ${world.exitEarly}` : "",
    `/bin/sleep 300 & echo $! > "${join(dir, "child")}"`,
    world.kind !== undefined && !world.says
      ? `if [ -n "\${APPIMAGE_EXTRACT_AND_RUN:-}" ]; then echo '${OFFER("unpackaged")}' >&2; else echo '${emit}' >&2; fi`
      : emit ? `echo '${emit}' >&2` : "",
    "wait",
  ].join("\n");
  for (const arch of ["x86_64", "aarch64"]) {
    writeFileSync(join(dir, "build", `ohmail-linux-${arch}.AppImage`), `${image}\n`);
    chmodSync(join(dir, "build", `ohmail-linux-${arch}.AppImage`), 0o755);
  }
  // /dev/null is a character device, as /dev/fuse is; a plain file is not.
  writeFileSync(join(dir, "not-a-device"), "");
  expect(body, "the step no longer asks for /dev/fuse").toContain(FUSE_LINE);
  const script = body.replace(FUSE_LINE, `test -c ${world.noFuse ? join(dir, "not-a-device") : "/dev/null"} ||`);
  writeFileSync(join(dir, "step.sh"), script);
  const p = spawnSync("bash", ["step.sh"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: bin, HOME: dir, LC_ALL: "C", ...(world.env ?? {}) },
  });
  const childPid = existsSync(join(dir, "child")) ? Number(readFileSync(join(dir, "child"), "utf8")) : 0;
  return { code: p.status ?? -1, out: p.stdout ?? "", err: p.stderr ?? "", started: existsSync(join(dir, "started")), child: childPid };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* The harness is the Linux jobs' own: setsid, FUSE, Xvfb, an AppImage. */
describe.skipIf(process.platform !== "linux")("the mounted AppImage says it is an AppImage (a Linux-only harness)", () => {
  it("admits an image whose own updater line says installKind appimage", () => {
    const r = run(AMD64, { kind: "appimage" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`the mounted image reports installKind appimage: ${OFFER("appimage")}`);
  });

  it("refuses an image that reads itself as unpackaged, by name", () => {
    const r = run(AMD64, { kind: "unpackaged" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("INSTALL-KIND-NOT-APPIMAGE unpackaged");
    expect(r.err).toContain(OFFER("unpackaged"));
  });

  it("runs the image mounted even when the job's environment asks for extraction", () => {
    // The variable is unset on the way in, so the image reports what a mounted start reports.
    const r = run(AMD64, { kind: "appimage", env: { APPIMAGE_EXTRACT_AND_RUN: "1" } });
    expect(r.code, r.err).toBe(0);
    const cut = run(AMD64.replace("setsid env -u APPIMAGE_EXTRACT_AND_RUN ", "setsid env "), { kind: "appimage", env: { APPIMAGE_EXTRACT_AND_RUN: "1" } });
    expect(cut.code, "the unset was not what made it mounted").not.toBe(0);
    expect(cut.err).toContain("INSTALL-KIND-NOT-APPIMAGE unpackaged");
  });

  it("refuses an image that says nothing, rather than finding nothing wrong", () => {
    const r = run(AMD64, {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("INSTALL-KIND-NOT-READ");
    // The step's whole 120-poll wait, 6 s at the stub's 0.05 s, plus its spawns: 6.4 s on the CI VMs.
  }, 15_000);

  it("names an image that could not start, with what the runtime said", () => {
    const r = run(AMD64, { exitEarly: 127 });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("INSTALL-KIND-NOT-READ");
    expect(r.err).toContain("cannot mount the image");
  });

  it("reads the kind out of the line, not a word elsewhere in it", () => {
    const r = run(AMD64, { says: '{"service":"updater","event":"updater_offer","note":"appimage","installKind":"deb"}' });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("INSTALL-KIND-NOT-APPIMAGE deb");
  });

  it.each(["fusermount3", "Xvfb", "xwininfo"])("refuses by name, before the image starts, when %s is missing", (tool) => {
    const r = run(AMD64, { kind: "appimage", missingTool: tool });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`INSTALL-KIND-NOT-RUN: ${tool} is not installed`);
    expect(r.started, "the image was started with a tool missing").toBe(false);
  });

  it("refuses by name, before the image starts, when the runner has no FUSE device", () => {
    const r = run(AMD64, { kind: "appimage", noFuse: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("INSTALL-KIND-NOT-RUN: /dev/fuse is not a device on this runner");
    expect(r.started).toBe(false);
  });

  it("stops everything the image started, not only the image", () => {
    const r = run(AMD64, { kind: "appimage" });
    expect(r.code, r.err).toBe(0);
    expect(r.child, "the stub never started its child").toBeGreaterThan(0);
    expect(alive(r.child), `the image's child ${r.child} outlived the step`).toBe(false);
  });
});

describe("both Linux jobs carry it", () => {
  it.skipIf(process.platform !== "linux")("runs the same step in both, on each job's own image (a Linux-only harness)", () => {
    expect(ARM).toBe(AMD64.replace("build/ohmail-linux-x86_64.AppImage", "build/ohmail-linux-aarch64.AppImage"));
    const r = run(ARM, { kind: "appimage" });
    expect(r.code, r.err).toBe(0);
  });

  it("runs after the launch check and before the image is uploaded", () => {
    for (const [job, upload] of [["linux", "Upload the AppImage"], ["linux-arm64", "Upload the arm64 AppImage"]] as const) {
      const { from, to } = jobLines(job);
      const at = (name: string) => wf.findIndex((l, i) => i > from && i < to && l.trim() === `- name: ${name}`);
      expect(at("The packaged app opens a window that renders"), job).toBeGreaterThan(-1);
      expect(at(STEP)).toBeGreaterThan(at("The packaged app opens a window that renders"));
      expect(at(upload)).toBeGreaterThan(at(STEP));
      // No condition: a red here fails the job before its image is uploaded.
      const next = wf.findIndex((l, i) => i > at(STEP) && /^ {6}- (name|uses):/.test(l));
      expect(wf.slice(at(STEP), next).some((l) => /^\s+if:/.test(l)), `${job}: the step grew a condition`).toBe(false);
    }
    expect(wf.filter((l) => l.trim() === `- name: ${STEP}`)).toHaveLength(2);
  });

  it("installs the tool the mount needs in both prerequisite lists", () => {
    expect(wfText.split("xdg-utils rpm cpio fuse3 \\").length - 1).toBe(2);
  });
});
