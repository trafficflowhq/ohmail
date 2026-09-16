//! WHAT THE RENDERER IS COSTING THIS MACHINE — the half of the telemetry that was missing.
//!
//! The engine writes `engine_vitals` every five minutes and it is good telemetry pointed at the
//! one process that behaved correctly. On an 8 GB laptop with a large mailbox the app reached
//! 4.1 GB and held a core at 93.7 % for 29 minutes while `engine_vitals` stayed flat at
//! 217–373 MB, because the growth was in the webview, which nothing measured. The kernel then
//! killed an unrelated application.
//!
//! So the shell measures its own webview processes and says so in the same log, in the same shape,
//! on all three platforms: `VmRSS` from `/proc` on Linux, each helper's `ri_phys_footprint`
//! through libproc on macOS, each WebView2 process's working set through the toolhelp snapshot on
//! Windows. One rule decides which processes are ours, and it is ordinary code a fixture table can
//! drive; only the three readers under it touch an operating system.

use std::fmt;
use std::fs;
use std::path::Path;

/// The resident-set ceiling the renderer is expected to stay under, in kB.
///
/// READ, NOT WRITTEN. This was a literal here, and three other readers spelled the same ceiling
/// differently — a candidate was measured RED against one of them and 85% of the contract this
/// file shipped. The number now comes from [`crate::perf_budgets`], which is generated from the
/// one budget table, so the line a person reads in the log and the line a gate reddens on are the
/// same number. A crossing is a regression in the bound, not a big mailbox; it is a LOG LINE and
/// never a limit — the shell does not kill the window it is reporting on.
pub use crate::perf_budgets::RENDERER_BUDGET_KB;

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
    /// WHICH OF THE WEBVIEW'S PROCESSES THIS IS — on Linux a string from
    /// [`WEBKIT_PROCESS_NAMES`] and never one the process wrote, so `comm` being a truncated
    /// copy of the name cannot reach the log as the name. The other two platforms report the
    /// name their process table gave.
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

/// The webview's processes, as WebKit names its executables. The only list.
pub const WEBKIT_PROCESS_NAMES: &[&str] =
    &["WebKitWebProcess", "WebKitNetworkProcess", "WebKitGPUProcess"];

/// `TASK_COMM_LEN` from the kernel's `include/linux/sched.h` — 15 characters and a NUL.
pub const TASK_COMM_LEN: usize = 16;

/// THE RULE: which webview process an argument vector belongs to, by its `argv[0]` basename.
///
/// ARGV, NEVER `comm`. `comm` is the kernel's copy of the executable name capped at
/// [`TASK_COMM_LEN`], and two of the three names above are longer than the cap, so on Linux the
/// real processes read `WebKitWebProces` and `WebKitNetworkPr` and a full-name comparison matched
/// nothing on any install. `argv[0]` carries the whole name, so the question is asked where the
/// answer exists. The name that comes back is this file's, not the process's.
pub fn webkit_name_of_argv(argv0: &str) -> Option<&'static str> {
    WEBKIT_PROCESS_NAMES.iter().copied().find(|name| argv0.starts_with(name))
}

/// THE FALLBACK, for a process whose `cmdline` is empty — a zombie, or one already gone.
///
/// The comparison runs the OTHER WAY ROUND to the one that shipped: the NAME starts with the
/// comm, and the comm is the whole name or exactly the cap. `comm.starts_with(name)` cannot match
/// at all once the name is longer than 15 characters, which is the defect this replaces; the
/// length floor is what keeps a bare `WebKit` from passing as all three.
pub fn webkit_name_of_comm(comm: &str) -> Option<&'static str> {
    WEBKIT_PROCESS_NAMES
        .iter()
        .copied()
        .find(|name| name.starts_with(comm) && comm.len() >= name.len().min(TASK_COMM_LEN - 1))
}

/// The first token of a `/proc/<pid>/cmdline` body, reduced to its basename.
///
/// The body is NUL-separated. An empty one is a kernel thread or a process that has already gone,
/// and answers `None` so the caller falls back to `comm` rather than classifying an empty string.
pub fn argv0_basename(cmdline: &str) -> Option<String> {
    let first = cmdline.split('\0').next()?.trim();
    if first.is_empty() {
        return None;
    }
    let base = first.rsplit('/').next()?;
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

/// The cgroup scope a process was launched in, out of a `/proc/<pid>/cgroup` body.
///
/// The unified line is `0::<path>` and it is the only one read: a v1 body lists one controller per
/// line and no single one of them is "the scope".
pub fn parse_cgroup_scope(body: &str) -> Option<String> {
    for line in body.lines() {
        if let Some(path) = line.strip_prefix("0::") {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Is this row in the app's OWN scope? The second, independent reading of "is it ours".
///
/// The first is descent, and a `/proc` snapshot's `ppid` can name a pid the kernel has since
/// reused; the scope is read from the same directory in the same pass and refuses a row the pid
/// relation admits. NO SCOPE IS NOT A FILTER: a kernel or a container this cannot read must
/// narrow nothing, because turning an unreadable file into "no children" is how this module
/// reported a renderer holding a gigabyte as absent in the first place.
pub fn same_scope(mine: Option<&str>, theirs: Option<&str>) -> bool {
    match (mine, theirs) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

/// One row of a platform's process table — the shape all three arms reduce to before anything is
/// selected.
///
/// The point of the shape is that the SELECTION is then ordinary code a test can drive with a
/// fixture table on any host: only the three readers below touch an operating system, and the rule
/// for which processes belong to this app lives above them where it can be watched fail. Without
/// it, two thirds of this file would be reachable only on the machine it runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: u32,
    pub name: String,
    /// WHOSE PROCESS THIS IS, in the platform's own answer: the parent on Linux and Windows, the
    /// RESPONSIBLE process on macOS. A WebKit helper there is an XPC service launchd started, so
    /// its parent is pid 1 on every install and descent answers nothing; responsibility is the
    /// relation that platform keys its own sandbox and consent prompts on.
    pub ppid: u32,
    /// Already in kB — every reader converts at the point where the platform's unit is known.
    pub rss_kb: Option<u64>,
}

/// Whether a macOS process name is one of the WKWebView's helper processes.
///
/// A PREFIX and not a list of three: WebKit's helpers are XPC services named for their bundle ids
/// under one namespace, the set differs by macOS version, and the sandboxed variants carry
/// suffixes (`…WebContent.Development`). `proc_name` answers the last path component truncated to
/// 33 bytes, which every name in that namespace fits inside.
pub fn is_macos_webkit_helper(name: &str) -> bool {
    name.starts_with("com.apple.WebKit.")
}

/// Whether a Windows process name is one of the WebView2 runtime's processes.
///
/// One executable for every role — browser, renderer, GPU, utility — so the name cannot say which
/// a process is and does not need to: the tree walk below is what makes it OURS.
pub fn is_webview2_helper(name: &str) -> bool {
    name.eq_ignore_ascii_case("msedgewebview2.exe")
}

/// Bytes to kB, the unit `rssKb` is named in.
///
/// macOS and Windows answer in bytes and Linux in the kernel's own kB, so exactly one of the three
/// arms converts and it does so here. Not a page count: no page size enters any figure this module
/// reports, which is the property `no_page_size_literal_and_no_statm_read` holds.
pub fn kb_of_bytes(bytes: u64) -> u64 {
    bytes / 1024
}

/// WHAT THIS PASS ACTUALLY READ — three states, and no fourth.
///
/// `measured:true` over an empty child list is the one reading that must never be inventable, and
/// it is exactly the reading the shipped Linux build produced for a webview holding a gigabyte. It
/// is now UNREPRESENTABLE rather than watched for: [`vitals_line`] derives this from the children
/// it was handed and takes no flag, so there is nothing to pass wrongly. A pass that classified
/// nothing also NAMES that, instead of reading like a platform that does not measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reading {
    /// At least one of the webview's processes answered with a figure.
    Measured,
    /// None were found — a window not yet open, a rule that stopped matching, or a step of the
    /// platform's that answered nothing. [`Blind`] narrows that last case into which step it was.
    NoChildrenClassified,
    /// They were found and not one of them gave a figure.
    NoFigures,
}

impl Reading {
    /// The word the log carries. From this enum, never from a caller.
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Reading::Measured => None,
            Reading::NoChildrenClassified => Some("no_children_classified"),
            Reading::NoFigures => Some("no_figures"),
        }
    }

    pub fn measured(self) -> bool {
        matches!(self, Reading::Measured)
    }
}

/// The one decider. Everything that reports reads it.
pub fn reading_of(children: &[Child]) -> Reading {
    if children.is_empty() {
        Reading::NoChildrenClassified
    } else if children.iter().any(|c| c.rss_kb.is_some()) {
        Reading::Measured
    } else {
        Reading::NoFigures
    }
}

/// Did this pass read a figure at all? [`reading_of`] answers it; this is the short spelling.
pub fn measured_of(children: &[Child]) -> bool {
    reading_of(children).measured()
}

/// WHICH STEP ANSWERED NOTHING, when a pass classified no webview process.
///
/// `no_children_classified` is honest and says nothing a reader can act on. These four name the
/// step, so a machine reporting no renderer says whether the process table, the webview, the
/// platform's answer about ownership or this app's share of it was what came back empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blind {
    /// The platform would not list its processes.
    NoProcessTable,
    /// It listed them and not one is a webview process — no window is open yet.
    NoWebviewProcess,
    /// Webview processes were listed and the platform would not say whose any of them are.
    NoOwnerAnswer,
    /// It said, and every one of them belongs to another application.
    NoHelperOfOurs,
}

impl Blind {
    /// The word the log carries. From this enum, never from a caller.
    pub fn reason(self) -> &'static str {
        match self {
            Blind::NoProcessTable => "no_process_table",
            Blind::NoWebviewProcess => "no_webview_process",
            Blind::NoOwnerAnswer => "no_owner_answer",
            Blind::NoHelperOfOurs => "no_helper_of_ours",
        }
    }
}

/// Which of the four it was, from three counts: how many processes a pass listed, how many of
/// those are the webview's by name, and how many of THOSE the platform attributed to anybody.
///
/// Counts and not a platform, so the arm where the ownership call refuses is driven by a table on
/// every CI rather than only on the machine it happens on. It narrows a REASON and nothing else.
pub fn blind_of(listed: usize, named: usize, attributed: usize) -> Blind {
    if listed == 0 {
        Blind::NoProcessTable
    } else if named == 0 {
        Blind::NoWebviewProcess
    } else if attributed == 0 {
        Blind::NoOwnerAnswer
    } else {
        Blind::NoHelperOfOurs
    }
}

/// ONE PASS'S ANSWER: the webview processes it classified, and — only where it classified none —
/// which step was silent.
///
/// `blind` cannot make a figure appear. [`vitals_line`] still derives `measured` from the children
/// and takes this for the WORD alone, so a narrower name for an absence is not a second way to
/// claim a measurement.
pub struct Pass {
    pub children: Vec<Child>,
    pub blind: Option<Blind>,
}

/// The webview's processes in a process table, by descent from `root`.
///
/// `whole_tree` is the difference between the two non-Linux platforms and is not a preference.
/// macOS hands this rule the RESPONSIBLE pid as each row's owner, and responsibility is already
/// transitive — every helper of the app names the app, so one step is the whole family there.
/// WebView2 starts ONE browser process as a child and that process starts the renderer, GPU and
/// utility processes — which is where the memory is — so a direct-children walk there would report
/// the one process that holds none of it. The descent is a bounded fixpoint rather than recursion:
/// the table is a snapshot, a reused pid can make it cyclic, and a walk that trusts it terminates
/// is a hang in a reporting thread.
pub fn helpers_of(
    rows: &[ProcRow],
    root: u32,
    is_helper: fn(&str) -> bool,
    whole_tree: bool,
) -> Vec<Child> {
    let mut family: std::collections::HashSet<u32> = std::collections::HashSet::new();
    family.insert(root);
    if whole_tree {
        for _ in 0..rows.len() {
            let mut grew = false;
            for r in rows {
                if r.pid != root && family.contains(&r.ppid) && family.insert(r.pid) {
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }
    } else {
        for r in rows {
            if r.pid != root && r.ppid == root {
                family.insert(r.pid);
            }
        }
    }
    let mut out: Vec<Child> = rows
        .iter()
        .filter(|r| r.pid != root && family.contains(&r.pid) && is_helper(r.name.as_str()))
        .map(|r| Child { pid: r.pid, name: r.name.clone(), rss_kb: r.rss_kb })
        .collect();
    out.sort_by_key(|c| c.pid);
    out
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
/// A child that gave no figure is `null` and is NAMED as unmeasured, and a pass that read no
/// figure at all reports `measured:false` with a `null` total — a zero here would say the renderer
/// costs nothing, which is the one reading that must never be inventable. THE CALLER CANNOT SAY
/// `measured`: it is derived from the children, so `measured:true, children:[]` is not a line this
/// function can produce. `reason` names WHICH absence this is — the reading's own word, or the
/// narrower one a platform's reader supplies for a pass that classified nothing.
pub fn vitals_line(children: &[Child], blind: Option<Blind>, uptime_min: u64) -> String {
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
    let reading = reading_of(children);
    let total: Option<u64> = if reading.measured() {
        Some(children.iter().filter_map(|c| c.rss_kb).sum())
    } else {
        None
    };
    let total_s = total.map_or("null".to_string(), |t| t.to_string());
    // The word is an enum's — the reading's, or the platform's narrower one for the empty case —
    // so nothing a caller holds can become text in this line. `blind` narrows the WORD only:
    // `measured` and the total come from the children above and no argument here can move them.
    let word = match (reading, blind) {
        (Reading::NoChildrenClassified, Some(b)) => Some(b.reason()),
        _ => reading.reason(),
    };
    let reason = word.map_or("null".to_string(), |r| format!("\"{r}\""));
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_vitals\",\"measured\":{},\"reason\":{},\"totalRssKb\":{},\"budgetKb\":{},\"uptimeMin\":{},\"children\":[{}]}}",
        reading.measured(), reason, total_s, RENDERER_BUDGET_KB, uptime_min, parts
    )
}

/// The `renderer_memory_high` line — one per crossing.
pub fn budget_line(total_rss_kb: u64) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_memory_high\",\"totalRssKb\":{},\"budgetKb\":{}}}",
        total_rss_kb, RENDERER_BUDGET_KB
    )
}

/// WHAT THE WINDOW IS ALLOWED TO SAY ABOUT ITSELF — the whole vocabulary of `ui_vitals`.
///
/// The renderer is the process that holds somebody's mail, so the shell does not forward a line it
/// composed: [`ui_vitals_line`] reads THESE names out of what the window reported, takes a number
/// or nothing from each, and writes the line itself. A subject, an address or a folder name is
/// therefore not something this path can carry wrongly — it is not representable, which is the
/// same argument `renderer_vitals` rests on one function up.
///
/// Three startup marks, three interaction pairs with their counts, the frame sampler's two
/// counters, and the client engine's own cost — the derivation the renderer pays whenever the
/// mirror's version moves, measured at 180–236 ms on a large mailbox. Four fields for it, because
/// one number cannot answer both questions a slow mailbox raises: `deriveMs` is the WORST pass of
/// the window, `deriveP50Ms`/`deriveP95Ms` what the window was usually like, `deriveCount` how many
/// bumps paid it, and `notifiesPer5min` how many the shell was told about.
pub const UI_VITALS_FIELDS: &[&str] = &[
    "shellPaintedMs",
    "listUsableMs",
    "engineReadyMs",
    "openP50Ms",
    "openP95Ms",
    "openCount",
    "switchP50Ms",
    "switchP95Ms",
    "switchCount",
    "searchP50Ms",
    "searchP95Ms",
    "searchCount",
    "longFrames",
    "longTasks",
    "deriveMs",
    "deriveP50Ms",
    "deriveP95Ms",
    "deriveCount",
    "notifiesPer5min",
    "uptimeMin",
];

/// The `ui_vitals` line, composed from numbers and nothing else.
///
/// A field the window did not report, reported as a string, or reported as a negative or
/// non-finite number, is `null` — "not answered" and "answered wrongly" both read as absent rather
/// than as zero, because zero is a measurement and these are not. Keys the window invented are
/// dropped: the vocabulary is this file's, never the caller's.
pub fn ui_vitals_line(reported: &serde_json::Value) -> String {
    let mut parts = String::new();
    for (i, name) in UI_VITALS_FIELDS.iter().enumerate() {
        if i > 0 {
            parts.push(',');
        }
        let value = match reported.get(name).and_then(|v| v.as_f64()) {
            Some(n) if n.is_finite() && n >= 0.0 => (n.round() as u64).to_string(),
            _ => "null".to_string(),
        };
        // The NAME comes from the constant above, never from the payload, so nothing the window
        // sent can become a key.
        parts.push_str(&format!("\"{name}\":{value}"));
    }
    format!("{{\"service\":\"ui\",\"event\":\"ui_vitals\",{parts}}}")
}

/// The scope of one pid under a `/proc`-shaped root, or `None` when it cannot be read.
fn scope_in(proc_root: &Path, pid: u32) -> Option<String> {
    fs::read_to_string(proc_root.join(pid.to_string()).join("cgroup"))
        .ok()
        .as_deref()
        .and_then(parse_cgroup_scope)
}

/// Every WebKit child of `parent`, read from a `/proc`-shaped directory.
///
/// Takes the root so the tests can hand it a fixture tree: a census that can only run against the
/// real `/proc` is a census that never runs in CI.
///
/// THREE INDEPENDENT QUESTIONS, all of which must answer yes. Is it ours by descent (`ppid`); is
/// it ours by scope (the cgroup the app was launched in, and no scope narrows nothing); and is it
/// one of the webview's, by `argv[0]` — with `comm` only where there is no argv, and read as the
/// capped string the kernel actually gives.
pub fn webkit_children_in(proc_root: &Path, parent: u32) -> Vec<Child> {
    let mut out = Vec::new();
    let mine = scope_in(proc_root, parent);
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
        if ppid != parent {
            continue;
        }
        if !same_scope(mine.as_deref(), scope_in(proc_root, pid).as_deref()) {
            continue;
        }
        let argv0 = fs::read_to_string(dir.join("cmdline"))
            .ok()
            .as_deref()
            .and_then(argv0_basename);
        let role = match argv0.as_deref() {
            Some(argv0) => webkit_name_of_argv(argv0),
            None => webkit_name_of_comm(&comm),
        };
        let role = match role {
            Some(role) => role,
            None => continue,
        };
        let rss_kb = fs::read_to_string(dir.join("status"))
            .ok()
            .as_deref()
            .and_then(parse_vm_rss_kb);
        out.push(Child { pid, name: role.to_string(), rss_kb });
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

/// How often the WINDOW reports — `apps/webapp/app/shell/ui-vitals.ts`'s `REPORT_EVERY_MS`, which
/// this shell has to know because it answers the window with the cadence it wants. The two are
/// asserted equal by a census in the webapp's tests, which reads both out of source.
pub const UI_VITALS_EVERY: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// The two knobs' names, and the bounds every one of them is read through.
///
/// A run shorter than five minutes reads no figure of the app's own — which is why every recorded
/// renderer reading of this app so far came from a sampler standing outside it. Both instruments
/// are therefore settable within a range, and the range is where the value that would break them
/// lives: below a second an instrument is a cost on the thing it measures, and above an hour a
/// soak records nothing a single sample could not have told it. Absent leaves the shipped default.
pub const RENDERER_VITALS_VAR: &str = "OHMAIL_RENDERER_VITALS_MS";
pub const UI_VITALS_VAR: &str = "OHMAIL_UI_VITALS_MS";
pub const VITALS_INTERVAL_MIN_MS: u64 = 1_000;
pub const VITALS_INTERVAL_MAX_MS: u64 = 60 * 60_000;

/// One environment value, ruled on BY NAME. `Ok(None)` is an absent knob; `Err` is a refusal
/// sentence naming the variable and the range, and never the value — an environment string is the
/// operator's own and this process does not repeat it into a log somebody else may read.
pub fn interval_ms_from_env(var: &str, raw: Option<&str>) -> Result<Option<u64>, String> {
    let text = match raw.map(str::trim) {
        Some(text) if !text.is_empty() => text,
        _ => return Ok(None),
    };
    let refusal = || {
        format!(
            "{var} must be whole milliseconds between {VITALS_INTERVAL_MIN_MS} and              {VITALS_INTERVAL_MAX_MS}; unset it for the shipped interval"
        )
    };
    let ms: u64 = text.parse().map_err(|_| refusal())?;
    if !(VITALS_INTERVAL_MIN_MS..=VITALS_INTERVAL_MAX_MS).contains(&ms) {
        return Err(refusal());
    }
    Ok(Some(ms))
}

/// The resolved interval for one knob, read from the environment ONCE.
///
/// Once, because a refusal is worth saying and worth saying only once: an instrument on a timer
/// would otherwise repeat it for the life of the app. A refused knob keeps the shipped default —
/// the shell does not fail to launch over the cadence of its own instrument — and the sentence
/// names which variable was ignored so nobody reads the default as the knob having taken.
fn resolved(slot: &'static std::sync::OnceLock<std::time::Duration>, var: &str,
            default: std::time::Duration) -> std::time::Duration {
    *slot.get_or_init(|| match interval_ms_from_env(var, std::env::var(var).ok().as_deref()) {
        Ok(Some(ms)) => std::time::Duration::from_millis(ms),
        Ok(None) => default,
        Err(sentence) => {
            crate::engine::log_line(format_args!("{sentence}"));
            default
        }
    })
}

/// How often this shell samples the renderer. [`SAMPLE_EVERY`] unless the knob says otherwise.
pub fn sample_every() -> std::time::Duration {
    static SLOT: std::sync::OnceLock<std::time::Duration> = std::sync::OnceLock::new();
    resolved(&SLOT, RENDERER_VITALS_VAR, SAMPLE_EVERY)
}

/// The cadence this shell ASKS THE WINDOW FOR, answered on every `ui_vitals` call.
pub fn ui_vitals_interval() -> std::time::Duration {
    static SLOT: std::sync::OnceLock<std::time::Duration> = std::sync::OnceLock::new();
    resolved(&SLOT, UI_VITALS_VAR, UI_VITALS_EVERY)
}

/// Where the real process table lives. A constant so the tests never touch it. Linux's alone —
/// the other two platforms answer through a system call, not a filesystem.
#[cfg(target_os = "linux")]
const PROC: &str = "/proc";

/* ── THE THREE READERS — the only code here that touches an operating system ─────────────────── */

/// The webview's processes and what each is charged, on Linux.
#[cfg(target_os = "linux")]
fn renderer_children(me: u32) -> Pass {
    Pass { children: webkit_children_in(Path::new(PROC), me), blind: None }
}

/// The webview's processes and what each is charged, on macOS.
#[cfg(target_os = "macos")]
fn renderer_children(me: u32) -> Pass {
    mac::renderer_children(me)
}

/// The webview's processes and what each is charged, on Windows.
#[cfg(target_os = "windows")]
fn renderer_children(me: u32) -> Pass {
    Pass { children: win::renderer_children(me), blind: None }
}

/// Nowhere else is built, and a platform that appears later reports itself unmeasured rather than
/// reporting zeroes — [`measured_of`] turns an empty answer into `"measured":false`.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn renderer_children(_me: u32) -> Pass {
    Pass { children: Vec::new(), blind: None }
}

/// macOS: the webview processes this app is responsible for, through four libSystem symbols.
///
/// libproc and the responsibility call are both declared in libSystem, which every binary on this
/// platform already links, so this adds no third-party code to the manifest that is published and
/// licence-audited — the same trade `security_ffi` in `engine.rs` and the Launch Services probes
/// in `default_mail.rs` make, and the reason no crate is added for seven declarations.
///
/// DESCENT ANSWERS NOTHING HERE, AND THAT WAS MEASURED. WebKit starts its content processes as XPC
/// services, so every helper's parent is launchd; an app started the ordinary way is re-parented to
/// launchd too, so a child walk finds the engine and no webview at all, and this build wrote
/// `"measured":false` on every launch. The platform's own answer to "whose process is this" is the
/// RESPONSIBLE pid — unprivileged for another process of the same user — so that is what the rule
/// above is handed as each row's owner, and the enumeration is the whole process table rather than
/// a family.
#[cfg(target_os = "macos")]
mod mac {
    use super::{blind_of, is_macos_webkit_helper, kb_of_bytes, Pass, ProcRow};

    extern "C" {
        fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
        fn proc_name(pid: i32, buffer: *mut u8, buffersize: u32) -> i32;
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut RUsageInfoV0) -> i32;
        fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    }

    /// `rusage_info_v0` — the oldest flavour, and the one that already carries the figure this
    /// module wants. A later flavour would add fields after these and buy nothing but a struct
    /// whose layout has to be kept in step with a header this repository does not compile.
    #[repr(C)]
    #[derive(Default)]
    struct RUsageInfoV0 {
        ri_uuid: [u8; 16],
        ri_user_time: u64,
        ri_system_time: u64,
        ri_pkg_idle_wkups: u64,
        ri_interrupt_wkups: u64,
        ri_pageins: u64,
        ri_wired_size: u64,
        ri_resident_size: u64,
        ri_phys_footprint: u64,
        ri_proc_start_abstime: u64,
        ri_proc_exit_abstime: u64,
    }

    const RUSAGE_INFO_V0: i32 = 0;

    /// `proc_name` answers the last path component truncated to `2 * MAXCOMLEN + 1` bytes. The
    /// buffer is comfortably that; nothing here reads a name for more than its prefix.
    const NAME_BYTES: usize = 64;

    /// What one enumeration answered, for each of the three steps that can come back empty.
    struct Scan {
        rows: Vec<ProcRow>,
        listed: usize,
        named: usize,
        attributed: usize,
    }

    pub fn renderer_children(me: u32) -> Pass {
        // THE ROOT IS THE PID THIS PROCESS IS ITSELF ATTRIBUTED TO — the app on an ordinary
        // launch, the terminal that started it on a developer machine. The helpers carry whichever
        // one it is, so asking rather than assuming `me` makes both installs read.
        let root = responsible_for(me as i32).unwrap_or(me);
        let scan = scan_webview_processes(me);
        let children = super::helpers_of(&scan.rows, root, is_macos_webkit_helper, false);
        // A pass that classified nothing names WHICH step was silent, and still reports no figure.
        let blind = if children.is_empty() {
            Some(blind_of(scan.listed, scan.named, scan.attributed))
        } else {
            None
        };
        Pass { children, blind }
    }

    /// Every webview process on the machine, with the pid the platform holds responsible for it.
    ///
    /// The name is read for every pid because that is the cheap question; only a webview process's
    /// owner and footprint are asked for, since charging every process on the machine would be
    /// hundreds of calls for figures nothing reads. Which of them are OURS is not decided here.
    fn scan_webview_processes(me: u32) -> Scan {
        let mut out = Scan { rows: Vec::new(), listed: 0, named: 0, attributed: 0 };
        let pids = all_pids();
        out.listed = pids.len();
        for pid in pids {
            if pid <= 0 || pid as u32 == me {
                continue;
            }
            let name = match name_of(pid) {
                Some(name) => name,
                None => continue, // it exited between the listing and the read
            };
            if !is_macos_webkit_helper(&name) {
                continue;
            }
            out.named += 1;
            let owner = match responsible_for(pid) {
                Some(owner) => owner,
                None => continue, // the platform would not say, and the rule may not guess
            };
            out.attributed += 1;
            out.rows.push(ProcRow { pid: pid as u32, name, ppid: owner, rss_kb: footprint_kb(pid) });
        }
        out
    }

    /// Every pid on the machine.
    ///
    /// THE CALL ANSWERS A COUNT OF PIDS AND TAKES A SIZE IN BYTES — the two are not the same unit,
    /// and reading the answer as bytes was measured on a Mac: a machine running 674 processes read
    /// as 168, the walk covered 57 of them, and the three helpers this exists to find were all
    /// above that line. A truncated process table reads as a smaller renderer rather than as a
    /// failure, so a buffer that comes back EXACTLY full is asked again with room, and a second
    /// exact fill is reported as no table at all rather than as a short one.
    fn all_pids() -> Vec<i32> {
        let slot = std::mem::size_of::<i32>();
        let count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Vec::new();
        }
        for headroom in [64usize, count as usize + 64] {
            let cap = count as usize + headroom;
            let mut pids = vec![0i32; cap];
            let written = unsafe { proc_listallpids(pids.as_mut_ptr(), (cap * slot) as i32) };
            if written <= 0 {
                return Vec::new();
            }
            let written = written as usize;
            if written < cap {
                pids.truncate(written);
                return pids;
            }
        }
        Vec::new()
    }

    fn name_of(pid: i32) -> Option<String> {
        let mut buf = [0u8; NAME_BYTES];
        let written = unsafe { proc_name(pid, buf.as_mut_ptr(), NAME_BYTES as u32) };
        if written <= 0 {
            return None;
        }
        let len = (written as usize).min(NAME_BYTES);
        let text = std::str::from_utf8(&buf[..len]).ok()?;
        Some(text.trim_end_matches('\0').to_string())
    }

    /// The pid this platform holds responsible for `pid`, or `None` where it refuses.
    ///
    /// A refusal is a step that answered nothing and is reported as one — never a process of
    /// nobody's, which would be counted as another application's and drop a real renderer.
    fn responsible_for(pid: i32) -> Option<u32> {
        let owner = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
        if owner <= 0 {
            return None;
        }
        Some(owner as u32)
    }

    /// `ri_phys_footprint` and not `ri_resident_size`: the footprint is the figure this platform
    /// charges a process and shows in its own activity monitor, and it counts the compressed and
    /// purgeable memory a resident-set figure leaves out — which on a webview is most of what
    /// grows.
    fn footprint_kb(pid: i32) -> Option<u64> {
        let mut info = RUsageInfoV0::default();
        let rc = unsafe { proc_pid_rusage(pid, RUSAGE_INFO_V0, &mut info) };
        if rc != 0 {
            return None;
        }
        Some(kb_of_bytes(info.ri_phys_footprint))
    }
}

/// Windows: the WebView2 processes under this app, through the toolhelp snapshot.
///
/// Every symbol is kernel32's, which std already links — `windows-sys` is in the dependency graph
/// five times over under other crates, and naming one of those versions directly would put a
/// version choice in a manifest that is published and licence-audited for six declarations.
#[cfg(target_os = "windows")]
mod win {
    use super::{is_webview2_helper, kb_of_bytes, Child, ProcRow};

    type Handle = *mut core::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    /// The narrowest access that answers a memory question — never `PROCESS_ALL_ACCESS`.
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const MAX_PATH: usize = 260;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; MAX_PATH],
    }

    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn K32GetProcessMemoryInfo(
            process: Handle,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// The whole family and not the children: WebView2 starts one browser process as this app's
    /// child, and THAT process starts the renderer, GPU and utility processes the memory is in.
    /// The figure is read only for the processes the walk selected — a snapshot has every process
    /// on the machine in it, and opening each one to ask would be hundreds of handles every five
    /// minutes to answer a question about four.
    pub fn renderer_children(me: u32) -> Vec<Child> {
        let mut found = super::helpers_of(&process_table(), me, is_webview2_helper, true);
        for child in &mut found {
            child.rss_kb = working_set_kb(child.pid);
        }
        found
    }

    fn process_table() -> Vec<ProcRow> {
        let mut out = Vec::new();
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        // `INVALID_HANDLE_VALUE` is -1 and not null, so both are refused: a snapshot this process
        // may not take must read as "no table" rather than as an empty one.
        if snapshot.is_null() || snapshot as isize == -1 {
            return out;
        }
        let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) };
        while more != 0 {
            out.push(ProcRow {
                pid: entry.th32_process_id,
                name: name_of(&entry.sz_exe_file),
                ppid: entry.th32_parent_process_id,
                rss_kb: None,
            });
            more = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) };
        out
    }

    /// The UTF-16 name up to its terminator. Lossy on purpose: a name this reader cannot decode
    /// must not drop the process from a memory census.
    fn name_of(wide: &[u16]) -> String {
        let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
        String::from_utf16_lossy(&wide[..end])
    }

    /// `WorkingSetSize` — the resident figure, the same quantity Linux's `VmRSS` names, so the
    /// three platforms' `rssKb` can be read as one series.
    fn working_set_kb(pid: u32) -> Option<u64> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            ..Default::default()
        };
        let ok = unsafe { K32GetProcessMemoryInfo(process, &mut counters, counters.cb) };
        unsafe { CloseHandle(process) };
        if ok == 0 {
            return None;
        }
        Some(kb_of_bytes(counters.working_set_size as u64))
    }
}

/// Start the reporting thread, and volunteer the WebKit children on Linux.
///
/// ALL THREE PLATFORMS MEASURE NOW. Linux reads `VmRSS` from `/proc`, macOS reads each helper's
/// `ri_phys_footprint` through libproc, Windows reads each WebView2 process's working set through
/// the toolhelp snapshot — one line, one shape, one five-minute clock. A pass that reads no figure
/// says `"measured":false` instead of a total of zero, so "this build does not measure the
/// renderer" and "the renderer costs nothing" stay different readings. The thread is detached and
/// never joined: it outlives nothing, holds no lock, and a failed read is skipped rather than
/// reported every five minutes.
pub fn start() {
    std::thread::spawn(|| {
        let me = std::process::id();
        let started = std::time::Instant::now();
        let mut previous_total: Option<u64> = None;
        #[cfg(target_os = "linux")]
        let root = std::path::PathBuf::from(PROC);
        #[cfg(target_os = "linux")]
        let mut volunteered: std::collections::HashSet<u32> = std::collections::HashSet::new();
        #[cfg(target_os = "linux")]
        let mut refusal_logged = false;
        loop {
            // The webview's processes come and go with the window, so the set is re-read every
            // pass rather than captured once at boot — at which point there is no renderer yet.
            let Pass { children, blind } = renderer_children(me);

            #[cfg(target_os = "linux")]
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
            crate::engine::log_json_line(&vitals_line(&children, blind, uptime_min));

            // Only a measured pass moves the comparison: a pass that found no renderer would
            // otherwise read as "back under budget" and re-arm the crossing.
            if reading_of(&children).measured() {
                let total: u64 = children.iter().filter_map(|c| c.rss_kb).sum();
                if crossed_budget(previous_total, total, RENDERER_BUDGET_KB) {
                    crate::engine::log_json_line(&budget_line(total));
                }
                previous_total = Some(total);
            }

            std::thread::sleep(sample_every());
        }
    });
}

#[cfg(test)]
#[path = "vitals_tests.rs"]
mod tests;
