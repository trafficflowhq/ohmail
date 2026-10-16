import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE FLATPAK PERMISSION STEP, RUN FROM THE WORKFLOW'S OWN TEXT. It compares the manifest's
 * finish-args with the built metadata as sets and admits one derived entry: flatpak 1.14 writes x11
 * beside a declared fallback-x11. Its first run on a runner (the public build of 2026-09-25) refused
 * that exact metadata on a string needle; the fixture below is those bytes.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WF = readFileSync(resolve(ROOT, publicRel("github/workflows/build.yml")), "utf8");
const MANIFEST_PATH = "apps/desktop/flatpak/app.ohmail.Desktop.yml";
const MANIFEST = readFileSync(resolve(ROOT, MANIFEST_PATH), "utf8");
const STEP = "The app ships the permissions it says it does";

/** The built metadata the public build of the 0.25.0 tag printed (2026-09-25), byte for byte. */
export const REAL_METADATA = `[Application]
name=app.ohmail.Desktop
runtime=org.gnome.Platform/x86_64/50
sdk=org.gnome.Sdk/x86_64/50
command=ohmail

[Context]
shared=network;ipc;
sockets=x11;wayland;fallback-x11;
devices=dri;

[Session Bus Policy]
org.kde.StatusNotifierWatcher=talk
org.freedesktop.Notifications=talk
org.freedesktop.secrets=talk
`;

function stepText(text: string, name: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `      - name: ${name}`);
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && /^ {6}- (name|uses): /.test(l));
  return lines.slice(at, end < 0 ? lines.length : end).join("\n");
}

function runBody(step: string): string {
  const lines = step.split("\n");
  const r = lines.findIndex((l) => l === "        run: |");
  if (r < 0) return "";
  const body: string[] = [];
  for (const l of lines.slice(r + 1)) {
    if (l !== "" && !l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return body.join("\n").trimEnd();
}

const BODY = runBody(stepText(WF, STEP));

/** The step's body in a tree holding the given manifest and metadata (null leaves a file out). */
function runStep(manifest: string | null, metadata: string | null): { rc: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "flatpak-permissions-"));
  try {
    mkdirSync(join(dir, dirname(MANIFEST_PATH)), { recursive: true });
    mkdirSync(join(dir, "flatpak-build"));
    if (manifest !== null) writeFileSync(join(dir, MANIFEST_PATH), manifest);
    if (metadata !== null) writeFileSync(join(dir, "flatpak-build/metadata"), metadata);
    writeFileSync(join(dir, "step.sh"), `${BODY}\n`);
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "step.sh"], { cwd: dir, encoding: "utf8" });
    return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function edited(text: string, from: string, to: string): string {
  expect(text, `the fixture has no ${JSON.stringify(from)} to replace`).toContain(from);
  return text.replace(from, to);
}

const RED = "flatpak permissions: RED -- ";

describe("the step is there and spawns only what it asserted", () => {
  it("finds the step and its body (a census of nothing is not a pass)", () => {
    expect(stepText(WF, STEP), "the step is not in the workflow").not.toBe("");
    expect(BODY).toContain("node -e '");
  });

  it("asserts node by name before it runs it, and runs nothing else", () => {
    const lines = BODY.split("\n");
    const open = lines.indexOf("node -e '");
    const close = lines.findIndex((l, i) => i > open && l.startsWith("' "));
    expect([open, close].every((i) => i > 0), "the node script is not delimited").toBe(true);
    const shell = [...lines.slice(0, open), lines[open]!, ...lines.slice(close)];
    expect(shell).toEqual([
      'command -v node >/dev/null || { echo "node is not installed" >&2; exit 1; }',
      "node -e '",
      `' ${MANIFEST_PATH} flatpak-build/metadata`,
    ]);
  });
});

describe("the built metadata against the manifest, as sets", () => {
  it("admits the real build: x11 is derived from fallback-x11 and nothing else differs", () => {
    const r = runStep(MANIFEST, REAL_METADATA);
    expect(r.out).toContain("flatpak permissions: GREEN -- 8 declared, all built; x11 derived by flatpak from fallback-x11");
    expect(r.out).not.toContain(RED);
    expect(r.rc).toBe(0);
  });

  it("admits a flatpak that does not derive x11", () => {
    const r = runStep(MANIFEST, edited(REAL_METADATA, "sockets=x11;wayland;", "sockets=wayland;"));
    expect(r.out).toContain("flatpak permissions: GREEN -- 8 declared, all built\n");
    expect(r.rc).toBe(0);
  });

  it("refuses a socket the build gained and the manifest does not declare", () => {
    const r = runStep(MANIFEST, edited(REAL_METADATA, "fallback-x11;\n", "fallback-x11;pulseaudio;\n"));
    expect(r.out).toContain(`${RED}the built app carries [Context] sockets=pulseaudio, which the manifest does not declare`);
    expect(r.rc).toBe(1);
  });

  it("refuses a permission the manifest declares and the build lacks", () => {
    const manifest = edited(MANIFEST, "  - --talk-name=org.freedesktop.secrets\n",
      "  - --talk-name=org.freedesktop.secrets\n  - --talk-name=org.freedesktop.FileManager1\n");
    const r = runStep(manifest, REAL_METADATA);
    expect(r.out).toContain(`${RED}the built app is missing [Session Bus Policy] org.freedesktop.FileManager1=talk, which the manifest declares`);
    expect(r.rc).toBe(1);
  });

  it("admits x11 only beside a declared fallback-x11", () => {
    const manifest = edited(MANIFEST, "  - --socket=fallback-x11\n", "");
    const r = runStep(manifest, edited(REAL_METADATA, "sockets=x11;wayland;fallback-x11;", "sockets=x11;wayland;"));
    expect(r.out).toContain(`${RED}the built app carries [Context] sockets=x11, which the manifest does not declare`);
    expect(r.rc).toBe(1);
  });

  it("refuses a --filesystem grant even when the manifest declares it", () => {
    const manifest = edited(MANIFEST, "  - --device=dri\n", "  - --device=dri\n  - --filesystem=home\n");
    const r = runStep(manifest, edited(REAL_METADATA, "devices=dri;\n", "devices=dri;\nfilesystems=home;\n"));
    expect(r.out).toContain(`${RED}the built app carries a --filesystem grant: [Context] filesystems=home`);
    expect(r.out).not.toContain("which the manifest");
    expect(r.rc).toBe(1);
  });
});

describe("what the step cannot read is a refusal, never a pass", () => {
  it("refuses a finish-arg and a metadata group it does not map, by name", () => {
    const manifest = edited(MANIFEST, "  - --device=dri\n", "  - --device=dri\n  - --env=GDK_BACKEND=x11\n  - --nosocket=x11\n");
    const r = runStep(manifest, `${REAL_METADATA}\n[Environment]\nGDK_BACKEND=x11\n\n[Instance]\nx=1\n`);
    // The --env pair maps to [Environment] on both sides, so only the two unread shapes refuse.
    expect(r.out.split("\n").filter((l) => l.startsWith(RED))).toEqual([
      `${RED}a finish-arg this check does not map: --nosocket=x11`,
      `${RED}the built metadata carries a group this check does not read: [Instance]`,
    ]);
    expect(r.rc).toBe(1);
  });

  it("refuses an absent, an empty or a group-less metadata and a manifest without finish-args", () => {
    for (const [manifest, metadata, why] of [
      [MANIFEST, null, "cannot read flatpak-build/metadata"],
      [MANIFEST, "", "flatpak-build/metadata carries no permission, so nothing was read"],
      [MANIFEST, "[Application]\nname=app.ohmail.Desktop\n", "carries no permission, so nothing was read"],
      [MANIFEST, `shared=network;\n${REAL_METADATA}`, "a metadata line outside any group: shared=network;"],
      [edited(MANIFEST, "finish-args:\n", "finish-arguments:\n"), REAL_METADATA, `${MANIFEST_PATH} has no finish-args list`],
    ] as const) {
      const r = runStep(manifest, metadata);
      expect(r.out, why).toContain(`${RED}`);
      expect(r.out, why).toContain(why);
      expect(r.rc, why).toBe(1);
    }
  });
});
