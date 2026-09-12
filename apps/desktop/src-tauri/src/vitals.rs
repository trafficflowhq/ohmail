//! WHAT THE RENDERER IS COSTING THIS MACHINE — the half of the telemetry that was missing.
//!
//! The engine writes `engine_vitals` every five minutes and it is good telemetry pointed at the
//! one process that behaved correctly. On an 8 GB laptop with a large mailbox the app reached
//! 4.1 GB and held a core at 93.7 % for 29 minutes while `engine_vitals` stayed flat at
//! 217–373 MB, because the growth was in the webview, which nothing measured. The kernel then
//! killed an unrelated application.
//!
//! So the shell measures its own WebKit children and says so in the same log, in the same shape.

use std::fmt;
use std::fs;
use std::path::Path;

/// The resident-set ceiling the renderer is expected to stay under, in kB.
///
/// 1.5 GB, and the number has an origin: the incident measured 4.1 GB for the process group with
/// the renderer alone at 923 MB nine minutes in, and the fixed build's renderer is bounded by its
/// mirror window rather than by the mailbox. A crossing is therefore a real regression in the
/// bound and not a big mailbox. It is a LOG LINE, never a limit — the shell does not kill the
/// window it is reporting on.
pub const RENDERER_BUDGET_KB: u64 = 1_500 * 1024;

/// `oom_score_adj` for the WebKit children, on Linux.
///
/// Chromium volunteers its renderers at 300 for this reason: when the app is the heaviest thing on
/// the machine, the kernel should reclaim ITS memory rather than whichever neighbour was most
/// polite. In the incident the kernel killed a well-behaved 1.3 GB application while the 4.1 GB
/// process that caused the pressure kept running. Raising is unprivileged; lowering is not, and
/// this only ever raises.
pub const WEBKIT_OOM_SCORE_ADJ: i32 = 300;

/// One WebKit child and what it is charged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub pid: u32,
    /// The kernel's own `comm`, e.g. `WebKitWebProcess`.
    pub name: String,
    /// `None` when this platform gave no figure — reported as `null`, never as zero.
    pub rss_kb: Option<u64>,
}

/// `VmRSS` from a `/proc/<pid>/status` body, in kB.
///
/// THE KERNEL'S OWN kB, AND NO PAGE ARITHMETIC. `statm` counts PAGES, and a figure derived by
/// multiplying them by a 4096 literal is four times too low on a 16 KB-page host — which is
/// exactly the machine the incident was measured on (Asahi, `getconf PAGESIZE` = 16384). Reading
/// `VmRSS` removes the page size from the calculation altogether, so the mistake cannot be made
/// here rather than being watched for.
pub fn parse_vm_rss_kb(status: &str) -> Option<u64> {
    for line in status.lines() {
        let rest = match line.strip_prefix("VmRSS:") {
            Some(rest) => rest,
            None => continue,
        };
        let mut parts = rest.split_whitespace();
        let value = parts.next()?;
        // The unit is stated by the kernel and asserted rather than assumed: a future unit would
        // otherwise be read as kB and reported four orders of magnitude out.
        if parts.next()? != "kB" {
            return None;
        }
        return value.parse::<u64>().ok();
    }
    None
}

/// The parent pid and `comm` from a `/proc/<pid>/stat` body.
///
/// `comm` is in parentheses and MAY CONTAIN SPACES AND PARENTHESES, so the fields after it are
/// found from the LAST `)` rather than by splitting the line — the usual bug here is a process
/// named `(foo bar)` shifting every later field by one.
pub fn parse_stat_parent(stat: &str) -> Option<(String, u32)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_string();
    let after = stat.get(close + 1..)?;
    let mut fields = after.split_whitespace();
    let _state = fields.next()?;
    let ppid = fields.next()?.parse::<u32>().ok()?;
    Some((comm, ppid))
}

/// Whether a `comm` is one of the webview's own processes.
pub fn is_webkit_child(comm: &str) -> bool {
    comm.starts_with("WebKitWebProcess")
        || comm.starts_with("WebKitNetworkProcess")
        || comm.starts_with("WebKitGPUProcess")
}

/// Has the renderer just crossed the budget, going up?
///
/// ONCE PER CROSSING, which is why the previous reading is a parameter: a renderer sitting at
/// 1.6 GB must not write this line every five minutes for the rest of the session, and one that
/// falls back under and climbs again is a second, real crossing.
pub fn crossed_budget(previous_kb: Option<u64>, now_kb: u64, budget_kb: u64) -> bool {
    now_kb > budget_kb && previous_kb.map_or(true, |p| p <= budget_kb)
}

/// The `renderer_vitals` line, in the shape the engine's own lines carry.
///
/// A child that gave no figure is `null` and is NAMED as unmeasured: macOS and Windows have no
/// `/proc`, and a zero there would read as a renderer costing nothing.
pub fn vitals_line(children: &[Child], measured: bool, uptime_min: u64) -> String {
    let mut parts = String::new();
    for (i, c) in children.iter().enumerate() {
        if i > 0 {
            parts.push(',');
        }
        let rss = match c.rss_kb {
            Some(kb) => kb.to_string(),
            None => "null".to_string(),
        };
        // The name is the kernel's `comm`, so it is quoted through serde rather than interpolated.
        let name = serde_json::to_string(&c.name).unwrap_or_else(|_| "\"?\"".to_string());
        parts.push_str(&format!("{{\"pid\":{},\"name\":{},\"rssKb\":{}}}", c.pid, name, rss));
    }
    let total: Option<u64> = if measured {
        Some(children.iter().filter_map(|c| c.rss_kb).sum())
    } else {
        None
    };
    let total_s = total.map_or("null".to_string(), |t| t.to_string());
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_vitals\",\"measured\":{},\"totalRssKb\":{},\"budgetKb\":{},\"uptimeMin\":{},\"children\":[{}]}}",
        measured, total_s, RENDERER_BUDGET_KB, uptime_min, parts
    )
}

/// The `renderer_memory_high` line — one per crossing.
pub fn budget_line(total_rss_kb: u64) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_memory_high\",\"totalRssKb\":{},\"budgetKb\":{}}}",
        total_rss_kb, RENDERER_BUDGET_KB
    )
}

/// Every WebKit child of `parent`, read from a `/proc`-shaped directory.
///
/// Takes the root so the tests can hand it a fixture tree: a census that can only run against the
/// real `/proc` is a census that never runs in CI.
pub fn webkit_children_in(proc_root: &Path, parent: u32) -> Vec<Child> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(proc_root) {
        Ok(entries) => entries,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid: u32 = match name.to_str().and_then(|s| s.parse().ok()) {
            Some(pid) => pid,
            None => continue, // `/proc` holds plenty that is not a pid
        };
        let dir = entry.path();
        let stat = match fs::read_to_string(dir.join("stat")) {
            Ok(stat) => stat,
            Err(_) => continue, // the process exited between the listing and the read
        };
        let (comm, ppid) = match parse_stat_parent(&stat) {
            Some(pair) => pair,
            None => continue,
        };
        if ppid != parent || !is_webkit_child(&comm) {
            continue;
        }
        let rss_kb = fs::read_to_string(dir.join("status"))
            .ok()
            .as_deref()
            .and_then(parse_vm_rss_kb);
        out.push(Child { pid, name: comm, rss_kb });
    }
    out.sort_by_key(|c| c.pid);
    out
}

/// Volunteer one process as the kernel's preferred victim. `true` when the write landed.
///
/// Silent on refusal BY DESIGN and reported once by the caller: a hardened kernel or a container
/// may refuse the write, and that is not a condition the reader can do anything about.
pub fn raise_oom_score(proc_root: &Path, pid: u32, score: i32) -> bool {
    let path = proc_root.join(pid.to_string()).join("oom_score_adj");
    fs::write(path, format!("{score}\n")).is_ok()
}

/// A one-line summary for the prose log, so a reader who greps nothing still sees the figure.
pub fn describe(children: &[Child]) -> impl fmt::Display + '_ {
    struct D<'a>(&'a [Child]);
    impl fmt::Display for D<'_> {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            if self.0.is_empty() {
                return write!(f, "no webview processes measured");
            }
            let mut first = true;
            for c in self.0 {
                if !first {
                    write!(f, ", ")?;
                }
                first = false;
                match c.rss_kb {
                    Some(kb) => write!(f, "{} {} MB", c.name, kb / 1024)?,
                    None => write!(f, "{} unmeasured", c.name)?,
                }
            }
            Ok(())
        }
    }
    D(children)
}

/// How often the shell reports. Beside `engine_vitals`, which is also five minutes, so one grep
/// over the log puts the two processes' figures on the same clock.
pub const SAMPLE_EVERY: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Where the real process table lives. A constant so the tests never touch it.
const PROC: &str = "/proc";

/// Start the reporting thread, and volunteer the WebKit children on Linux.
///
/// LINUX ONLY, AND IT SAYS SO ONCE. There is no `/proc` on macOS or Windows and the platform APIs
/// that would answer there are not wired, so those builds write one line naming the renderer as
/// unmeasured rather than a stream of zeroes. The thread is detached and never joined: it outlives
/// nothing, holds no lock, and a failed read is skipped rather than reported every five minutes.
pub fn start() {
    std::thread::spawn(|| {
        let me = std::process::id();
        let root = std::path::PathBuf::from(PROC);
        let linux = root.join(me.to_string()).join("status").exists();
        if !linux {
            crate::engine::log_json_line(&vitals_line(&[], false, 0));
            return;
        }

        let started = std::time::Instant::now();
        let mut previous_total: Option<u64> = None;
        let mut volunteered: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut refusal_logged = false;
        loop {
            // The webview's processes come and go with the window, so the set is re-read every
            // pass rather than captured once at boot — at which point there is no renderer yet.
            let children = webkit_children_in(&root, me);
            for c in &children {
                if volunteered.contains(&c.pid) {
                    continue;
                }
                if raise_oom_score(&root, c.pid, WEBKIT_OOM_SCORE_ADJ) {
                    volunteered.insert(c.pid);
                } else if !refusal_logged {
                    refusal_logged = true;
                    crate::engine::log_line(format_args!(
                        "could not raise oom_score_adj on the webview processes; this kernel refuses \
                         the write, so the system will pick its own victim under memory pressure"
                    ));
                }
            }

            let uptime_min = started.elapsed().as_secs() / 60;
            crate::engine::log_json_line(&vitals_line(&children, true, uptime_min));

            let total: u64 = children.iter().filter_map(|c| c.rss_kb).sum();
            if crossed_budget(previous_total, total, RENDERER_BUDGET_KB) {
                crate::engine::log_json_line(&budget_line(total));
            }
            // Only a measured pass moves the comparison: a pass that found no renderer would
            // otherwise read as "back under budget" and re-arm the crossing.
            if !children.is_empty() {
                previous_total = Some(total);
            }

            std::thread::sleep(SAMPLE_EVERY);
        }
    });
}

#[cfg(test)]
#[path = "vitals_tests.rs"]
mod tests;
