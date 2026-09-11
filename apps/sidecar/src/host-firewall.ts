import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Is this computer's own firewall holding the LAN door shut? — the honesty half of same-network
 * access. The door binds and says so, and on a default-deny firewall (Omarchy/Arch ufw) BOTH are
 * true while nothing on the network can reach the port. The self-probe is the obvious answer and is
 * WRONG, measured: a packet this machine sends to an address it holds routes over `lo`, and ufw's
 * first rule accepts `lo`, so the probe reports reachable over a firewall dropping every real client.
 * So this READS ufw's own world-readable state (`ufw.conf`, `default/ufw`, the `### tuple ###`
 * lines), and the verdict is FOUR-WAY with `unreadable` load-bearing: on macOS/Windows/nftables it
 * manufactures no certainty, and it does NOT open the port — silently acquiring root to widen exposure is a worse product.
 */

/** Where ufw keeps the three facts. Overridable so tests never read the host's real firewall. */
export interface UfwPaths {
  readonly conf: string;
  readonly defaults: string;
  readonly rules: string;
}

export const UFW_PATHS: UfwPaths = {
  conf: "/etc/ufw/ufw.conf",
  defaults: "/etc/default/ufw",
  rules: "/etc/ufw/user.rules",
};

/**
 * The three file bodies as they were read, `null` for any that could not be. A field being null
 * is never an error — it is the ordinary answer on every machine that does not run ufw.
 */
export interface UfwSources {
  readonly conf: string | null;
  readonly defaults: string | null;
  readonly rules: string | null;
}

/**
 * What this computer's firewall does to inbound TCP on one port.
 *
 * `blocks` is the only verdict that produces a user-visible claim, and it carries the exact
 * command that fixes it — a remedy the operator can read, understand and refuse.
 */
export type UfwVerdict =
  | { readonly state: "allows" }
  | { readonly state: "inactive" }
  | { readonly state: "blocks"; readonly remedy: string }
  | { readonly state: "unreadable" };

/** `KEY=value` / `KEY="value"` out of a shell-ish config file. Null when the key is absent. */
function shellValue(body: string, key: string): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    return line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return null;
}

/**
 * The direction token, found by SCANNING rather than by index — because neither "field 7" nor "the
 * last field" is right, and both were wrong before the shapes were measured on a real ufw. Four
 * forms came out of `/etc/ufw/user.rules`: the ordinary rule (`… in`), a comment appended AFTER the
 * direction, an app profile inserting TWO positional fields BEFORE it (`… MailHost - in`), and an
 * interface-qualified `in_enp0s2`. A fixed index read the PROFILE NAME as the direction and rejected
 * every rule made with `ufw allow <profile>` — which this module's header calls a supported
 * packaging path, so it would have nagged exactly the machines that did it the recommended way.
 */
function directionOf(fields: readonly string[]): string | null {
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    const field = fields[i]!;
    if (/^(in|out|fwd)(_|$)/.test(field)) return field;
  }
  return null;
}

/** `a.b.c.d` as a number, or null when it is not a dotted quad. */
function ipToInt(value: string): number | null {
  if (!isIPv4(value)) return null;
  return value.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

/**
 * Does a ufw address field cover `address`? `any` and the wildcards do; an exact match does; and
 * so does a CIDR block that CONTAINS it — `to 192.168.1.0/24` is a perfectly ordinary way to open
 * a port to one's own subnet, and reading it as "some other destination" made the pane tell such a
 * machine that nothing could connect while devices were connecting.
 */
function coversAddress(spec: string, address: string | null): boolean {
  if (spec === "any" || spec === "0.0.0.0/0" || spec === "::/0") return true;
  // Nothing to compare against — do not manufacture a mismatch.
  if (address === null) return true;
  if (spec === address) return true;
  const slash = spec.indexOf("/");
  if (slash < 0) return false;
  const bits = Number(spec.slice(slash + 1));
  const net = ipToInt(spec.slice(0, slash));
  const target = ipToInt(address);
  if (net === null || target === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((net & mask) >>> 0) === ((target & mask) >>> 0);
}

/**
 * Does one `### tuple ###` field list admit inbound TCP on `port` at `address`? The tuple is ufw's
 * own normalization (`action proto dport dst sport src dir`). Most tests here are deliberately
 * GENEROUS — a rule that plausibly covers the port counts — because a missed allow only nags about a
 * firewall that is already open, while a missed BLOCK is the defect this module exists to remove. The
 * interface qualifier is the one place that asymmetry FLIPS: `in_wlan0` admits the port on wlan0 and
 * nowhere else, so counting it for a door bound on eth0 would report a reachable door over a firewall
 * dropping every packet — a false SERVING. So an interface-qualified rule counts only when the
 * interface is demonstrably the one holding the bound address, and an unknown interface does not.
 */
function tupleAdmits(
  fields: readonly string[],
  port: number,
  address: string | null,
  boundInterface: string | null,
): boolean {
  const [action, proto, dport, dst] = fields;
  if (action === undefined || proto === undefined || dport === undefined) return false;
  // `limit` admits too — it is an allow that rate-limits. `allow_log`/`limit_log` are the
  // logging spellings of the same two actions.
  if (!/^(allow|limit)(_|$)/.test(action)) return false;
  const dir = directionOf(fields);
  // An absent direction is an old or short tuple — read it as inbound, as before.
  if (dir !== null) {
    if (!dir.startsWith("in")) return false;
    if (dir.startsWith("in_")) {
      const iface = dir.slice(3);
      if (boundInterface === null) return false;
      // `en+` is iptables' prefix wildcard and ufw passes it through verbatim — measured:
      // `ufw allow in on en+ …` writes `in_en+` here and `-i en+` in the rule beneath, which
      // does match `enp0s2`. Reading it as a literal interface name reported such a machine
      // blocked while the port was open.
      const wildcard = iface.endsWith("+");
      const matches = wildcard
        ? boundInterface.startsWith(iface.slice(0, -1))
        : iface === boundInterface;
      if (!matches) return false;
    }
  }
  if (proto !== "tcp" && proto !== "any") return false;
  if (dst !== undefined && !coversAddress(dst, address)) return false;
  return portCovered(dport, port);
}

/** The interface name holding `address` right now, or null when nothing on this box does. */
export function interfaceForAddress(address: string | null): string | null {
  if (address === null) return null;
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if ((list ?? []).some((iface) => iface.address === address)) return name;
  }
  return null;
}

/** ufw port fields: `any`, `6245`, a `6000:6010` range, or a `80,443` list of either. */
function portCovered(field: string, port: number): boolean {
  if (field === "any") return true;
  return field.split(",").some((part) => {
    const range = part.split(":");
    if (range.length === 2) {
      const lo = Number(range[0]);
      const hi = Number(range[1]);
      return Number.isInteger(lo) && Number.isInteger(hi) && port >= lo && port <= hi;
    }
    return Number(part) === port;
  });
}

/**
 * THE ONE READING of the three files. Pure — the caller supplies the bodies, so the whole
 * decision table is testable without a firewall, a root shell, or a particular operating system.
 *
 * `unitActive` is what the service manager says about ufw *right now*, or null when nothing
 * asked. It outranks `ufw.conf`'s `ENABLED`, which is only a start-at-boot preference: a box
 * whose unit is stopped is not filtering whatever the file says.
 */
export function ufwVerdict(opts: {
  readonly port: number;
  readonly address: string | null;
  readonly sources: UfwSources;
  readonly unitActive: boolean | null;
  /** The interface holding `address`, for interface-qualified rules. Null = not known. */
  readonly boundInterface?: string | null;
}): UfwVerdict {
  const { port, address, sources, unitActive } = opts;
  const boundInterface = opts.boundInterface ?? null;
  const enabled = sources.conf === null ? null : /^yes$/i.test(shellValue(sources.conf, "ENABLED") ?? "");

  // Not enforcing — whatever else is true, ufw is not what would stop a phone.
  if (unitActive === false) return { state: "inactive" };
  if (enabled === false) return { state: "inactive" };
  // Nothing said it is enforcing. No file, no unit, no claim.
  if (enabled !== true && unitActive !== true) return { state: "unreadable" };

  // Enforcing. Does inbound even need a rule? A box whose default input policy is ACCEPT admits
  // the port with no rule at all, and telling its owner to add one would be false advice.
  if (sources.defaults !== null) {
    const policy = shellValue(sources.defaults, "DEFAULT_INPUT_POLICY");
    if (policy !== null && /^accept$/i.test(policy)) return { state: "allows" };
  }

  if (sources.rules === null) return { state: "unreadable" };
  const tuples = sources.rules
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("### tuple ###"))
    .map((line) => line.slice("### tuple ###".length).trim().split(/\s+/));
  // A rules file with no `### RULES ###` marker is not the format this parser knows. An empty
  // rule set inside that marker is a real, blocking state; an unrecognised file is not knowledge.
  if (tuples.length === 0 && !sources.rules.includes("### RULES ###")) {
    return { state: "unreadable" };
  }
  if (tuples.some((fields) => tupleAdmits(fields, port, address, boundInterface))) {
    return { state: "allows" };
  }

  // Enforcing, default-deny, and no rule covers the port. This is the measured Omarchy case.
  if (sources.defaults === null) {
    // The policy could not be read, so "no rule" does not establish "blocked" on its own.
    return { state: "unreadable" };
  }
  return { state: "blocks", remedy: `sudo ufw allow ${port}/tcp` };
}

/** Read the three files, treating every failure as an absent fact. Never throws. */
export function readUfwSources(paths: UfwPaths = UFW_PATHS): UfwSources {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return { conf: read(paths.conf), defaults: read(paths.defaults), rules: read(paths.rules) };
}
