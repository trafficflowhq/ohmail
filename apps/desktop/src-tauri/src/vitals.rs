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

/// Did this pass read a figure at all?
///
/// `measured` means "a number in this line came from the operating system", so a pass that
/// enumerated and found nothing says `false` and reports `null` rather than a total of zero — a
/// renderer costing nothing is the one reading that must never be inventable. It is also the state
/// a launch is in before the webview's processes exist, and the state macOS is in if its helpers
/// are ever launched outside this app's process tree.
pub fn measured_of(children: &[Child]) -> bool {
    children.iter().any(|c| c.rss_kb.is_some())
}

/// The webview's processes in a process table, by descent from `root`.
///
/// `whole_tree` is the difference between the two non-Linux platforms and is not a preference.
/// macOS starts each helper as its own service, so the app's own children are the whole family.
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
/// costs nothing, which is the one reading that must never be inventable.
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

/// WHAT THE WINDOW IS ALLOWED TO SAY ABOUT ITSELF — the whole vocabulary of `ui_vitals`.
///
/// The renderer is the process that holds somebody's mail, so the shell does not forward a line it
/// composed: [`ui_vitals_line`] reads THESE names out of what the window reported, takes a number
/// or nothing from each, and writes the line itself. A subject, an address or a folder name is
/// therefore not something this path can carry wrongly — it is not representable, which is the
/// same argument `renderer_vitals` rests on one function up.
///
/// Three startup marks, three interaction pairs with their counts, the frame sampler's two
/// counters, and the client engine's own cost (`deriveMs`, `notifiesPer5min`) — the derivation the
/// renderer pays whenever the mirror's version moves, measured at 180–236 ms on a large
/// mailbox, and how many of those it was asked for in the window.
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

/// Where the real process table lives. A constant so the tests never touch it. Linux's alone —
/// the other two platforms answer through a system call, not a filesystem.
#[cfg(target_os = "linux")]
const PROC: &str = "/proc";

/* ── THE THREE READERS — the only code here that touches an operating system ─────────────────── */

/// The webview's processes and what each is charged, on Linux.
#[cfg(target_os = "linux")]
fn renderer_children(me: u32) -> Vec<Child> {
    webkit_children_in(Path::new(PROC), me)
}

/// The webview's processes and what each is charged, on macOS.
#[cfg(target_os = "macos")]
fn renderer_children(me: u32) -> Vec<Child> {
    mac::renderer_children(me)
}

/// The webview's processes and what each is charged, on Windows.
#[cfg(target_os = "windows")]
fn renderer_children(me: u32) -> Vec<Child> {
    win::renderer_children(me)
}

/// Nowhere else is built, and a platform that appears later reports itself unmeasured rather than
/// reporting zeroes — [`measured_of`] turns an empty answer into `"measured":false`.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn renderer_children(_me: u32) -> Vec<Child> {
    Vec::new()
}

/// macOS: the app's own helper processes, through three libproc symbols.
///
/// libproc lives in libSystem, which every binary on this platform already links, so this adds no
/// third-party code to the manifest that is published and licence-audited — the same trade
/// `security_ffi` in `engine.rs` and the Launch Services probes in `default_mail.rs` make, and the
/// reason no crate is added for six declarations.
///
/// WHAT THIS CANNOT SEE, said plainly: WebKit starts its content processes as XPC services, and a
/// service launchd started is not this process's child. Where that is what happens the enumeration
/// finds no helper, the line reads `"measured":false`, and the figure is absent rather than wrong.
/// That is the state to check first if a macOS run reports nothing.
#[cfg(target_os = "macos")]
mod mac {
    use super::{is_macos_webkit_helper, kb_of_bytes, Child, ProcRow};

    extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut i32, buffersize: i32) -> i32;
        fn proc_name(pid: i32, buffer: *mut u8, buffersize: u32) -> i32;
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut RUsageInfoV0) -> i32;
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

    pub fn renderer_children(me: u32) -> Vec<Child> {
        super::helpers_of(&process_table(me), me, is_macos_webkit_helper, false)
    }

    /// This app's direct children, named and charged.
    fn process_table(me: u32) -> Vec<ProcRow> {
        let mut out = Vec::new();
        let parent = me as i32;
        // ASK FOR THE SIZE FIRST. A fixed buffer would truncate silently on an install with more
        // children than somebody guessed, and a truncated process table reads as a smaller
        // renderer rather than as a failure.
        let bytes = unsafe { proc_listchildpids(parent, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return out;
        }
        let slot = std::mem::size_of::<i32>();
        // Headroom for a process started between the two calls.
        let count = (bytes as usize / slot) + 8;
        let mut pids = vec![0i32; count];
        let written =
            unsafe { proc_listchildpids(parent, pids.as_mut_ptr(), (count * slot) as i32) };
        if written <= 0 {
            return out;
        }
        for &pid in pids.iter().take((written as usize / slot).min(count)) {
            if pid <= 0 {
                continue;
            }
            let name = match name_of(pid) {
                Some(name) => name,
                None => continue, // it exited between the listing and the read
            };
            out.push(ProcRow { pid: pid as u32, name, ppid: me, rss_kb: footprint_kb(pid) });
        }
        out
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
            let children = renderer_children(me);

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
            let measured = measured_of(&children);
            crate::engine::log_json_line(&vitals_line(&children, measured, uptime_min));

            // Only a measured pass moves the comparison: a pass that found no renderer would
            // otherwise read as "back under budget" and re-arm the crossing.
            if measured {
                let total: u64 = children.iter().filter_map(|c| c.rss_kb).sum();
                if crossed_budget(previous_total, total, RENDERER_BUDGET_KB) {
                    crate::engine::log_json_line(&budget_line(total));
                }
                previous_total = Some(total);
            }

            std::thread::sleep(SAMPLE_EVERY);
        }
    });
}

#[cfg(test)]
#[path = "vitals_tests.rs"]
mod tests;
