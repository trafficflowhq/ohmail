import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * THE COMPUTER A CLOUD SEAL IS BOUND TO (`sealTokens` in `cloud-auth.ts`): a digest of the OS's
 * machine id, keyed to this one use, so the raw id never leaves this module. Null when the OS names
 * no machine; seals are then written and opened unbound, as before. It spawns a tool on macOS and
 * Windows, so only `cloud-engine.ts` imports it, which keeps it out of the phone's bundle.
 */
const DOMAIN = "ohmail cloud-tokens.seal machine v1";
/** `db.ts`'s probe bound: a tool that has not answered by then names no machine. */
const TOOL_BOUND_MS = 5_000;
const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
const IOREG_UUID = /"IOPlatformUUID"\s*=\s*"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/i;
const REG_GUID = /\bMachineGuid\s+REG_SZ\s+\{?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}?/i;

export interface MachineReadDeps {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
  run?: (file: string, args: readonly string[]) => Promise<string>;
}

const runTool = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", timeout: TOOL_BOUND_MS, windowsHide: true }, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });

async function machineId(deps: MachineReadDeps): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runTool;
  if (platform === "darwin") {
    const out = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    return IOREG_UUID.exec(out)?.[1]?.toLowerCase() ?? null;
  }
  if (platform === "win32") {
    const reg = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
    const out = await run(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
    return REG_GUID.exec(out)?.[1]?.toLowerCase() ?? null;
  }
  const readText = deps.readText ?? ((path: string) => readFile(path, "utf8"));
  for (const path of MACHINE_ID_FILES) {
    let id: string;
    try {
      id = (await readText(path)).trim();
    } catch {
      continue; // a file that cannot be read names no machine; the next one may
    }
    // systemd's own shape; `uninitialized` (a first boot) names no machine.
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  }
  return null;
}

/** This computer's seal binding, or null when it cannot be read. Never throws. */
export async function readMachineBinding(deps: MachineReadDeps = {}): Promise<string | null> {
  try {
    const id = await machineId(deps);
    return id === null ? null : createHmac("sha256", DOMAIN).update(id).digest("base64url");
  } catch {
    return null;
  }
}
