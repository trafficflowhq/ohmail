import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE RENDERER-VITALS RULE, READ OUT OF THE RUST AND REPLAYED OVER A REAL PROCESS TABLE.
 *
 * `vitals.rs` and its tests compile on the mirror's Linux, macOS and Windows CI (`cargo test`,
 * both configurations); this machine has no Rust toolchain, so the one defect that has actually
 * shipped would have no guard here at all between now and the next published build. This census
 * closes that window: it parses the deciding rule out of the source text rather than restating it,
 * and replays it over the process table an Omarchy guest was holding while the shipped build
 * reported the webview as absent.
 *
 * Three arms, and the middle one is the whole point: the shipped direction must find NOTHING in
 * that table, the source's own direction must find EVERYTHING, and the untruncated names must
 * still classify — which is the positive
 * control that the rule is not merely inverted, and the reason every Rust fixture passed while
 * production read zero.
 */

const SRC = join(__dirname, "..", "src-tauri", "src", "vitals.rs");
const src = readFileSync(SRC, "utf8");

/**
 * THE GUEST'S OWN TABLE. Read off an Omarchy guest on 2026-09-12 from `/proc/<pid>/comm` while an
 * external sampler held these two processes at 1 057 332 kB and the app's own log line said
 * `children:[]`. Three columns: pid, ppid, comm. These are the kernel's strings — fifteen
 * characters, because that is all `comm` has — and not names anybody typed.
 */
const GUEST_TABLE = [
  { pid: 2752936, ppid: 2752819, comm: "WebKitNetworkPr" },
  { pid: 2753026, ppid: 2752819, comm: "WebKitWebProces" },
];

/** The argument vectors those same processes carry, where the whole name survives. */
const GUEST_ARGV = [
  "/usr/lib/webkit2gtk-4.1/WebKitNetworkProcess",
  "/usr/lib/webkit2gtk-4.1/WebKitWebProcess",
  "/usr/lib/webkit2gtk-4.1/WebKitGPUProcess",
];

/** `TASK_COMM_LEN` from `include/linux/sched.h`: fifteen characters and a NUL. */
function commCap(): number {
  const declared = /pub const TASK_COMM_LEN: usize = (\d+);/.exec(src);
  return (declared ? Number(declared[1]) : 16) - 1;
}

/** The webview process names the source declares, in either spelling it has carried. */
function declaredNames(): string[] {
  const list = /pub const WEBKIT_PROCESS_NAMES: &\[&str\] =\s*&\[([^\]]*)\]/.exec(src);
  const body = list
    ? list[1]
    : (/pub fn is_webkit_child\(comm: &str\) -> bool \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "");
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(`no webview process names in ${SRC}: the rule has changed shape`);
  }
  return names;
}

/** The body of the function that classifies a Linux `comm`, in either spelling. */
function commRuleBody(): string {
  const fixed = /pub fn webkit_name_of_comm\(comm: &str\)[\s\S]*?\n\}/.exec(src);
  const shipped = /pub fn is_webkit_child\(comm: &str\)[\s\S]*?\n\}/.exec(src);
  const body = fixed?.[0] ?? shipped?.[0];
  if (!body) throw new Error(`no comm classifier in ${SRC}: the rule has changed shape`);
  return body;
}

/** Which of the two directions the source implements. Anything else refuses by name. */
function commRuleDirection(): "shipped" | "capped" {
  const body = commRuleBody();
  const capped = /name\.starts_with\(comm\)/.test(body) && /TASK_COMM_LEN/.test(body);
  const shipped = /comm\.starts_with\(/.test(body);
  if (capped) return "capped";
  if (shipped) return "shipped";
  throw new Error("the comm rule is neither direction this census knows; read it by hand");
}

/** `comm.starts_with(name)` — what shipped. */
const shippedMatch = (comm: string, names: string[]) => names.some((n) => comm.startsWith(n));

/** The name starts with the comm, and the comm is the whole name or exactly the cap. */
const cappedMatch = (comm: string, names: string[], cap: number) =>
  names.some((n) => n.startsWith(comm) && comm.length >= Math.min(n.length, cap));

describe("the Linux renderer-vitals rule, replayed over the guest's own process table", () => {
  /**
   * WHY THE DEFECT EXISTS, stated as a measurement rather than an explanation: two of the three
   * names the source declares are longer than a `comm` can ever be.
   */
  it("declares names that do not fit in a comm, which is what makes the direction matter", () => {
    const names = declaredNames();
    const cap = commCap();
    expect(cap).toBe(15);
    expect(names).toContain("WebKitWebProcess");
    expect(names).toContain("WebKitNetworkProcess");
    const tooLong = names.filter((n) => n.length > cap);
    expect(tooLong.length, `names longer than ${cap}: ${tooLong.join(", ")}`).toBeGreaterThanOrEqual(2);
  });

  /**
   * ARM 1 — the shipped direction over the guest's real comms. It must find NOTHING. This arm is
   * the recorded defect and does not move with the source: it is the contrast the next two are
   * read against.
   */
  it("the shipped direction finds none of the guest's two webview processes", () => {
    const names = declaredNames();
    const found = GUEST_TABLE.filter((r) => shippedMatch(r.comm, names));
    expect(found, `the shipped rule matched ${JSON.stringify(found)}`).toHaveLength(0);
  });

  /**
   * ARM 2 — THE ONE THAT DECIDES. The direction the source actually implements, replayed over the
   * same two rows. Both must classify. On a tree carrying the shipped rule this arm reads 0 of 2.
   */
  it("the rule this source implements classifies both of them", () => {
    const names = declaredNames();
    const cap = commCap();
    const direction = commRuleDirection();
    const match = (comm: string) =>
      direction === "capped" ? cappedMatch(comm, names, cap) : shippedMatch(comm, names);
    const found = GUEST_TABLE.filter((r) => match(r.comm));
    expect(
      found.map((r) => r.comm),
      `the ${direction} rule over the guest's table`,
    ).toEqual(["WebKitNetworkPr", "WebKitWebProces"]);
  });

  /**
   * ARM 3 — the positive control. The untruncated names, which no Linux kernel writes into `comm`
   * and which every Rust fixture used to write, still classify. Without this arm arm 2 could pass
   * for a rule that matches everything.
   */
  it("the untruncated names still classify, and nothing else does", () => {
    const names = declaredNames();
    const cap = commCap();
    const direction = commRuleDirection();
    const match = (comm: string) =>
      direction === "capped" ? cappedMatch(comm, names, cap) : shippedMatch(comm, names);
    for (const name of names) expect(match(name), name).toBe(true);
    for (const other of ["node", "ohmail", "WebKit", "WebKitWeb", "", "firefox"]) {
      expect(match(other), other).toBe(false);
    }
  });

  /**
   * THE RULE IS ARGV, AND `comm` IS ONLY THE FALLBACK. The source must carry an argv classifier,
   * and it must read the guest's real argv paths — where the whole name survives the kernel.
   */
  it("classifies by the argument vector, which carries the whole name", () => {
    expect(src, "the argv rule is missing").toMatch(/pub fn webkit_name_of_argv\(argv0: &str\)/);
    expect(src, "the basename reader is missing").toMatch(/pub fn argv0_basename\(cmdline: &str\)/);
    const names = declaredNames();
    for (const argv of GUEST_ARGV) {
      const base = argv.slice(argv.lastIndexOf("/") + 1);
      expect(names.some((n) => base.startsWith(n)), argv).toBe(true);
    }
    // The Linux reader asks argv first and falls back to comm, rather than the other way round.
    const reader = /pub fn webkit_children_in\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(reader).toMatch(/webkit_name_of_argv/);
    expect(reader).toMatch(/webkit_name_of_comm/);
    expect(reader.indexOf("webkit_name_of_argv")).toBeLessThan(reader.indexOf("webkit_name_of_comm"));
  });

  /**
   * AND THE STATE THAT MADE THE DEFECT LOOK HEALTHY IS UNREPRESENTABLE.
   *
   * The shipped build wrote `"measured":true,"totalRssKb":0,"children":[]`. `vitals_line` must
   * take no `measured` argument at all — a caller cannot pass what it is not given — and the two
   * absent readings must be told apart by a `reason` the enum owns.
   */
  it("gives the line no measured flag to be handed wrongly, and names the absence", () => {
    expect(src, "vitals_line takes a measured flag again").toMatch(
      /pub fn vitals_line\(children: &\[Child\], uptime_min: u64\) -> String/,
    );
    expect(src).toMatch(/Some\("no_children_classified"\)/);
    expect(src).toMatch(/Some\("no_figures"\)/);
    expect(src, "the line no longer carries a reason").toMatch(/\\"reason\\":\{\}/);
    // The reason word comes from the enum, so no caller's string can reach the log as one.
    const reason = /pub fn reason\(self\) -> Option<&'static str> \{[\s\S]*?\n    \}/.exec(src)?.[0];
    expect(reason, "the reason is not a method on the reading").toBeTruthy();
  });

  /**
   * The group half: descent AND scope, two independent readings of "is it ours". A `/proc`
   * snapshot's `ppid` can name a pid the kernel has since reused, and an unreadable scope must
   * narrow nothing rather than empty the answer.
   */
  it("filters by the app's own scope as well as by descent", () => {
    expect(src).toMatch(/pub fn parse_cgroup_scope\(body: &str\)/);
    expect(src).toMatch(/pub fn same_scope\(mine: Option<&str>, theirs: Option<&str>\)/);
    const reader = /pub fn webkit_children_in\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(reader, "the reader does not read a scope").toMatch(/same_scope\(/);
    expect(reader, "the reader stopped checking descent").toMatch(/ppid != parent/);
    // Both rows of the guest's table are children of the same shell, which is what licensed the
    // descent half staying as it was.
    expect(new Set(GUEST_TABLE.map((r) => r.ppid)).size).toBe(1);
  });
});
