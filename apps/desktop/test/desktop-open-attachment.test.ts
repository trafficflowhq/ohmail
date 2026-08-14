/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══ AN ATTACHMENT OPENS IN THIS COMPUTER'S OWN VIEWER ═════════════════════════════════════
 *
 * The defect: pressing an attachment in the desktop app did NOTHING. No file, no error, no log
 * line — and a PDF was worse, because the reader got a panel telling them to download it above a
 * Download button that could not deliver a file either.
 *
 * The mechanism, which is the link defect's twin rather than the same bug: the web client mints a
 * `blob:` URL and clicks a hidden `<a download>`. That attribute asks the webview to turn the
 * navigation into a download, the webview forwards the question to whatever the host registered to
 * perform one, this app registered nothing, and a webview with no download handler CANCELS the
 * navigation. Nothing refused a permission and no policy was consulted; the press was answered
 * correctly by a component whose correct answer is "no download".
 *
 * ── WHAT THIS FILE HOLDS DOWN ───────────────────────────────────────────────────────────────
 *
 *  1. armed, a press hands the shell the BYTES and the display name, and never an anchor;
 *  2. the window sends no path and no directory — the payload has exactly two fields, so there is
 *     no value a message could shape into a place on the disk;
 *  3. the WEB app is untouched: no command, and the anchor keeps the browser's own semantics;
 *  4. a PDF is not offered the in-app viewer on the desktop, because that build cannot draw one;
 *  5. the shell's grant names the command — the silent shape this family is prone to, since a
 *     command registered and not granted fails at the ACL with no window and no log;
 *  6. the name a message chose cannot name a file outside the shell's own directory (the Rust
 *     half of that is in `engine_tests.rs`; what is asserted here is that the window sends the
 *     name unaltered rather than composing anything).
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · make `deliverFile` fall back to `saveObjectUrl` when the       → the desktop delivery case
 *    desktop arm is armed                                             goes red;
 *  · make `deliverFile` take the desktop arm regardless of          → the web-app case goes red;
 *    `desktopAttachmentsEnabled()`
 *  · have `openAttachmentWithSystemViewer` send a third field       → the payload-shape case goes
 *    (a path, a directory)                                            red;
 *  · make `opensInSystemViewer` answer true without arming          → the web-app preview case
 *                                                                     goes red;
 *  · make `opensInSystemViewer` answer false for `application/pdf`  → the desktop preview case
 *                                                                     goes red;
 *  · register `open_attachment` and leave it out of the capability  → the grant case goes red;
 *  · drop `enableDesktopAttachments()` from `main.tsx`              → the arming case goes red.
 */

/* jsdom's `Blob` predates the async accessors every browser this app runs in has had for years,
   and the seam reads the bytes with `blob.arrayBuffer()`. Shimmed here through jsdom's own
   `FileReader`, which is the same stand-in the attachment preview's own suite installs for the
   PDF path. It is a gap in the TEST environment and nowhere else: WKWebView, WebView2 and
   WebKitGTK all have the method, and `AttachmentPreview.tsx` has read a PDF's bytes with it since
   the overlay landed. */
if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
    function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    };
}

type Invoked = { command: string; payload?: Record<string, unknown> };

let invoked: Invoked[] = [];

interface Host {
  __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> };
}
const host = globalThis as unknown as Host;

/** Anchor clicks the browser arm would have made, recorded rather than performed. */
let anchors: Array<{ href: string; download: string }> = [];
let clickSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  invoked = [];
  anchors = [];
  host.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      invoked.push({ command, payload });
      return Promise.resolve(null);
    },
  };
  /* jsdom performs no download, so the anchor arm is observed at the click: the seam creates the
     element, sets `href`/`download`, clicks it and removes it in one function, and the click is
     the only moment both fields are on a live node. */
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push({ href: this.href, download: this.download });
  });
  document.body.innerHTML = "";
  vi.resetModules();
});

afterEach(() => {
  clickSpy?.mockRestore();
  delete host.__TAURI_INTERNALS__;
});

/**
 * Wait until the press has been ANSWERED by one route or the other, or give up.
 *
 * Not a fixed `setTimeout(0)`, and the first draft of this file was: the desktop arm reads the
 * bytes asynchronously, the shim above does it through `FileReader`, and that settles later than
 * one macrotask. The cost of getting it wrong was not a flake but a LIE — the assertion ran before
 * the invoke, saw an empty list, and the invoke then landed in the NEXT case's array, where it
 * arrived under the previous case's file name. One failure reported in two places, neither of them
 * the real one.
 *
 * So the wait is on the condition rather than on the clock, and it returns the instant either side
 * acts. The bound exists so that a case asserting NOTHING happened terminates; a case asserting
 * something did fails on its own assertion rather than hanging.
 */
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (invoked.length > 0 || anchors.length > 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A fresh copy of the module — the armed flag is per-module, so each case starts disarmed. */
async function freshModule() {
  return import("../../webapp/app/shell/open-attachment.js");
}

/** The seam that chooses the route, from the same fresh graph as the module above. */
async function freshSeam() {
  return import("../../webapp/app/shell/attachments.js");
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE DESKTOP WINDOW, ARMED — the bytes go to the shell and no anchor is clicked.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the desktop window hands the file to the operating system", () => {
  it("a press sends the bytes and the display name, and clicks no anchor", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    const { deliverFile } = await freshSeam();

    const blob = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" });
    deliverFile(blob, "blob:tauri://localhost/abc", "Quarterly report.pdf", document);
    await settled();

    expect(anchors, "the desktop arm clicked a download anchor, which this window cancels").toEqual([]);
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.command).toBe(mod.OPEN_ATTACHMENT_COMMAND);
    expect(invoked[0]!.payload).toEqual({
      filename: "Quarterly report.pdf",
      // `%PDF` — the same four bytes the Blob was built from, unaltered on the way.
      bytes: [0x25, 0x50, 0x44, 0x46],
    });
  });

  /**
   * THE STRUCTURAL CASE: the window cannot name a place on the disk.
   *
   * Every part of the path is the shell's — the directory is the app's own, the unique component
   * is minted from the system's random source, and the name is sanitised there before it is
   * joined to anything (`engine.rs#attachment_file_name`, proven in `engine_tests.rs`). What is
   * asserted here is the half this side owns: the payload carries a name and bytes, and nothing
   * else, so there is no field a hostile name could arrive in as a path.
   */
  it("the payload names bytes and a display name — never a path, a directory or a root", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    const { deliverFile } = await freshSeam();

    deliverFile(new Blob(["x"]), "blob:tauri://localhost/abc", "../../.ssh/authorized_keys", document);
    await settled();

    const payload = invoked[0]!.payload!;
    expect(Object.keys(payload).sort()).toEqual(["bytes", "filename"]);
    // Sent AS THE MESSAGE WROTE IT. Repairing it here would put a second, quieter sanitiser in
    // front of the one that owns the decision, and the two would drift — the shell's is the one
    // that composes the path, so the shell's is the one that must be total.
    expect(payload.filename).toBe("../../.ssh/authorized_keys");
  });

  it("without bytes there is nothing to hand a viewer, so the anchor is still used", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    const { deliverFile } = await freshSeam();

    deliverFile(undefined, "blob:tauri://localhost/abc", "report.pdf", document);
    await settled();

    expect(invoked, "a command was called with no bytes to send").toEqual([]);
    expect(anchors).toEqual([{ href: "blob:tauri://localhost/abc", download: "report.pdf" }]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WEB APP — the same shared modules, imported and inert.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the web app is not touched", () => {
  it("without arming, a press is the download anchor it has always been", async () => {
    const mod = await freshModule();
    expect(mod.desktopAttachmentsEnabled()).toBe(false);
    const { deliverFile } = await freshSeam();

    deliverFile(new Blob(["x"]), "blob:http://localhost/abc", "report.pdf", document);
    await settled();

    expect(invoked, "the web app called a desktop shell command").toEqual([]);
    expect(anchors).toEqual([{ href: "blob:http://localhost/abc", download: "report.pdf" }]);
  });

  it("and a PDF keeps its in-app viewer there", async () => {
    const { opensInSystemViewer } = await freshModule();
    expect(opensInSystemViewer("application/pdf")).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   WHICH TYPES THE WINDOW GIVES UP ON — one, and for a stated reason.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("what the desktop hands over rather than drawing", () => {
  it("a PDF, because this build has no PDF renderer at all", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    expect(mod.opensInSystemViewer("application/pdf")).toBe(true);
    // The parameters a mail header carries are not part of the type.
    expect(mod.opensInSystemViewer("application/PDF; name=x.pdf")).toBe(true);
  });

  it("and nothing else — an image and a text part are drawn from bytes already in hand", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    for (const mime of [
      "image/png", "image/jpeg", "image/gif", "image/webp",
      "text/plain", "text/calendar",
      // Not previewable anywhere; its tile already saves, and this predicate must not be the
      // thing that decides that — `isPreviewable` owns it, in one place.
      "application/zip", "image/svg+xml",
    ]) {
      expect(mod.opensInSystemViewer(mime), `${mime} was taken off the in-app viewer`).toBe(false);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WIRING, FROM SOURCE — `desktop-attach-cap.test.ts`'s method, for the reasons it gives:
   what regresses in this family is a name missing from a literal, and the alternative is a
   window's worth of setup to observe one call.
   ───────────────────────────────────────────────────────────────────────────────────────── */

function sourceOf(rel: string): string {
  try {
    return readFileSync(resolve(process.cwd(), `apps/desktop/${rel}`), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }
}

describe("the window is granted the command it calls", () => {
  const engine = sourceOf("src-tauri/src/engine.rs");

  it("`open_attachment` is registered AND named in the capability", () => {
    expect(engine, "open_attachment is not in the invoke handler")
      .toMatch(/generate_handler!\[[^\]]*\bopen_attachment\b/s);

    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    expect(cap, "LOCAL_ENGINE_CAPABILITY could not be read out of engine.rs").not.toBeNull();
    const grant = JSON.parse(cap![1]!) as { windows: string[]; permissions: string[] };

    expect(grant.permissions, "the window may not call open_attachment")
      .toContain("allow-open-attachment");
    // The grant stays the main window's and stays one-directional. Asserted beside the addition
    // so a widening fails here too, the way the link slice's does.
    expect(grant.windows).toEqual(["main"]);
    expect(grant.permissions).not.toContain("core:event:allow-emit");
  });

  it("the shell composes the path and takes no filesystem permission to do it", () => {
    // The command takes a name and bytes. It must NEVER grow a path parameter: the whole argument
    // for crossing `LINKS`' no-URL rule here is that the window names no place on the disk.
    expect(engine).toMatch(/fn open_attachment\(\s*shell: tauri::State<'_, Arc<Shell>>,\s*filename: String,\s*bytes: Vec<u8>,\s*\)/);
    // And the grant carries no filesystem plugin permission — the write is this process's own.
    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    const grant = JSON.parse(cap![1]!) as { permissions: string[] };
    expect(grant.permissions.filter((p) => p.startsWith("fs:"))).toEqual([]);
    expect(grant.permissions.filter((p) => p.startsWith("shell:"))).toEqual([]);
    expect(grant.permissions.filter((p) => p.startsWith("dialog:"))).toEqual([]);
  });
});

describe("the engine-bearing build arms it, and the preview cannot", () => {
  const main = sourceOf("src/main.tsx");

  it("`enableDesktopAttachments` is called inside the build-time branch", () => {
    expect(main).toContain("enableDesktopAttachments");
    // Inside the literal's branch, so the bundler folds it out of the preview entirely — the
    // artifact whose published claim is that it calls no command.
    expect(main).toMatch(/if \(__OHMAIL_LOCAL_ENGINE__\)[\s\S]{0,600}?enableDesktopAttachments\(\)/);
  });

  it("and it is armed exactly once", () => {
    expect(main.match(/enableDesktopAttachments\(\)/g) ?? []).toHaveLength(1);
  });
});

describe("the reading pane withholds the in-app viewer for the type this build cannot draw", () => {
  it("MessagePane asks `opensInSystemViewer` alongside `isPreviewable`", () => {
    const rel = "apps/webapp/app/shell/MessagePane.tsx";
    let pane: string;
    try {
      pane = readFileSync(resolve(process.cwd(), rel), "utf8");
    } catch {
      pane = readFileSync(resolve(process.cwd(), "../webapp/app/shell/MessagePane.tsx"), "utf8");
    }
    expect(pane).toMatch(
      /canPreview=\{\(item\) => isPreviewable\(item\.mimeType\) && !opensInSystemViewer\(item\.mimeType\)\}/,
    );
  });
});
