/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══ AN ATTACHMENT REACHES THE PERSON'S DOWNLOADS FOLDER ═══════════════════════════════════
 *
 * The defect: pressing an attachment in the desktop app did NOTHING. No file, no error, no log
 * line — and a PDF was worse, because the reader got a panel telling them to download it above a
 * Download button that could not deliver a file either.
 *
 * The first repair ended the silence and answered a different question: it handed the bytes to the
 * platform VIEWER, so on a Mac an image opened in Preview, nothing arrived in `~/Downloads`, and
 * "Download all" had no desktop meaning at all. A button that says Download downloads. The desktop
 * arm now asks the shell to SAVE into the person's own Downloads folder (`save_attachment`), which
 * is the same act the browser's `<a download>` performs. `open_attachment` is gone: it wrote
 * bytes the window chose and launched them, with no caller left.
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
 *  1. armed, a press hands the shell the attachment's ID and the display name, and never an
 *     anchor or the bytes — to the SAVE command, once per file, "Download all" included; the
 *     engine streams the part to disk, so a 40 MiB file never enters this window;
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
 *  · point the desktop arm at any command but `save_attachment`      → the command-name assertion
 *                                                                     goes red;
 *  · have `deliverAll` deliver only the first file on the desktop    → the Download-all case goes
 *                                                                     red (it counts the calls);
 *  · make `deliverFile` take the desktop arm regardless of          → the web-app case goes red;
 *    `desktopAttachmentsEnabled()`
 *  · have `saveAttachmentToDownloads` send a third field            → the payload-shape case goes
 *    (a path, a directory, the bytes)                                 red;
 *  · make `opensInSystemViewer` answer true without arming          → the web-app preview case
 *                                                                     goes red;
 *  · make `opensInSystemViewer` answer false for `application/pdf`  → the desktop preview case
 *                                                                     goes red;
 *  · register `save_attachment` and leave it out of the capability  → the grant case goes red;
 *  · bring `open_attachment` back anywhere (handler, grant, build)  → the no-open case goes red;
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

/** The engine's half of a desktop save: run the delivery, as `OhmailEngine.deliverAttachment` does. */
const fakeEngine = {
  deliverAttachment: <T,>(_m: string, _a: string, deliver: () => Promise<T>) => deliver(),
};

const ID1 = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d21";
const ID2 = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d22";
const ID3 = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d23";

describe("the desktop window hands the file to the operating system", () => {
  it("a press sends the attachment's id and the display name, and clicks no anchor", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    const { deliverFile } = await freshSeam();

    void deliverFile(fakeEngine, {
      messageId: "m1", attachmentId: ID1, filename: "Quarterly report.pdf", url: "blob:tauri://localhost/abc",
    }, document);
    await settled();

    expect(anchors, "the desktop arm clicked a download anchor, which this window cancels").toEqual([]);
    expect(invoked).toHaveLength(1);
    // THE SAVE, not the open. A press of a button labelled Download that opened the file in a
    // viewer and left nothing in the person's Downloads folder is the defect above this one.
    expect(invoked[0]!.command).toBe(mod.SAVE_ATTACHMENT_COMMAND);
    expect(invoked[0]!.command).toBe("save_attachment");
    // The id and the name: the engine streams the part, so no byte of it crosses this bridge.
    expect(invoked[0]!.payload).toEqual({ attachmentId: ID1, filename: "Quarterly report.pdf" });
  });

  /**
   * THE STRUCTURAL CASE: the window cannot name a place on the disk.
   *
   * Every part of the path is the shell's — the directory is the app's own, the staging file is
   * minted from the system's random source, and the name is sanitised there before it is joined to
   * anything (`engine.rs#attachment_file_name`, proven in `engine_tests.rs`). What is asserted here
   * is the half this side owns: the payload carries an id and a name, and nothing else.
   */
  it("the payload names an id and a display name — never a path, a directory, a root or the bytes", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    const { deliverFile } = await freshSeam();

    void deliverFile(fakeEngine, { messageId: "m1", attachmentId: ID1, filename: "../../.ssh/authorized_keys" }, document);
    await settled();

    const payload = invoked[0]!.payload!;
    expect(Object.keys(payload).sort()).toEqual(["attachmentId", "filename"]);
    // Sent AS THE MESSAGE WROTE IT. Repairing it here would put a second, quieter sanitiser in
    // front of the one that owns the decision, and the two would drift — the shell's is the one
    // that composes the path, so the shell's is the one that must be total.
    expect(payload.filename).toBe("../../.ssh/authorized_keys");
  });

  it("the engine's refusal of the part is thrown for the tile, a shell refusal is said", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    host.__TAURI_INTERNALS__ = {
      invoke: () => Promise.reject({ status: 413, code: "payload_too_large", message: "over the limit", retryable: false }),
    };
    await expect(mod.saveAttachmentToDownloads(ID1, "big.mp4")).rejects.toMatchObject({
      code: "payload_too_large", status: 413, retryable: false,
    });
    host.__TAURI_INTERNALS__ = { invoke: () => Promise.reject("ohmail: this computer named no Downloads folder") };
    await expect(mod.saveAttachmentToDownloads(ID1, "big.mp4")).resolves.toBe("no-downloads-folder");
  });

  /**
   * "DOWNLOAD ALL" IS N SAVES, ONE PER FILE, IN ORDER — and it had no desktop meaning at all
   * before this: it delivered through the same seam, so it opened N viewers.
   *
   * Sequential and awaited, which is the OPPOSITE of what the browser arm needs (see
   * `deliverAll`'s header): the shell resolves a name collision against the filesystem at the
   * moment of the write, so two presses racing for `Invoice.pdf` must not be in flight together.
   * The count is asserted BY FILE NAME rather than by length alone — a loop that delivered the
   * first file three times would satisfy a length check.
   */
  it("Download all is one save per file, in order, and no anchor", async () => {
    const mod = await freshModule();
    mod.enableDesktopAttachments();
    const { deliverAll } = await freshSeam();

    const saved = await deliverAll(fakeEngine, [
      { messageId: "m1", attachmentId: ID1, filename: "Invoice.pdf" },
      { messageId: "m1", attachmentId: ID2, filename: "Photo.jpg" },
      { messageId: "m1", attachmentId: ID3, filename: "Notes.txt" },
    ], document);

    expect(saved, "the seam claimed a different number of files than it saved").toBe(3);
    expect(anchors, "Download all clicked an anchor in the window that cancels them").toEqual([]);
    expect(invoked.map((i) => i.command)).toEqual([
      mod.SAVE_ATTACHMENT_COMMAND,
      mod.SAVE_ATTACHMENT_COMMAND,
      mod.SAVE_ATTACHMENT_COMMAND,
    ]);
    expect(invoked.map((i) => i.payload!.filename)).toEqual(["Invoice.pdf", "Photo.jpg", "Notes.txt"]);
    expect(invoked.map((i) => i.payload!.attachmentId)).toEqual([ID1, ID2, ID3]);
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

    void deliverFile(fakeEngine, { messageId: "m1", attachmentId: ID1, filename: "report.pdf", url: "blob:http://localhost/abc" }, document);
    await settled();

    expect(invoked, "the web app called a desktop shell command").toEqual([]);
    expect(anchors).toEqual([{ href: "blob:http://localhost/abc", download: "report.pdf" }]);
  });

  /* The web's own "Download all": N anchor clicks, no shell command, and the count it reports is
     ZERO — the browser announces its own downloads, and a sentence from us about a folder this app
     cannot see would be a claim we have no way to check. */
  it("and Download all there is anchors, no command, and nothing claimed about a folder", async () => {
    const mod = await freshModule();
    expect(mod.desktopAttachmentsEnabled()).toBe(false);
    const { deliverAll } = await freshSeam();

    const saved = await deliverAll(fakeEngine, [
      { messageId: "m1", attachmentId: ID1, filename: "Invoice.pdf", url: "blob:http://localhost/1" },
      { messageId: "m1", attachmentId: ID2, filename: "Photo.jpg", url: "blob:http://localhost/2" },
    ], document);

    expect(saved, "the web arm claimed files reached a Downloads folder").toBe(0);
    expect(invoked, "the web app called a desktop shell command").toEqual([]);
    expect(anchors).toEqual([
      { href: "blob:http://localhost/1", download: "Invoice.pdf" },
      { href: "blob:http://localhost/2", download: "Photo.jpg" },
    ]);
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
  const read_preview = () => sourceOf("src-tauri/src/attachment_preview.rs");

  /**
   * NO COMMAND WRITES BYTES THE WINDOW CHOSE AND LAUNCHES THEM. `open_attachment`
   * did — 40 MiB under a window-chosen name, handed to the platform opener (rundll32 runs an `.exe`)
   * — with no caller left. Neither registered, granted, declared nor defined; the window names no
   * such command either.
   */
  it("`open_attachment` is gone: not registered, granted, declared or named by the window", () => {
    expect(engine, "open_attachment is in the invoke handler").not.toMatch(/generate_handler!\[[^\]]*\bopen_attachment\b/s);
    expect(engine).not.toMatch(/fn open_attachment\(/);
    expect(engine).not.toMatch(/fn spawn_file_opener\(/);
    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    expect(cap, "LOCAL_ENGINE_CAPABILITY could not be read out of engine.rs").not.toBeNull();
    const grant = JSON.parse(cap![1]!) as { windows: string[]; permissions: string[] };
    expect(grant.permissions).not.toContain("allow-open-attachment");
    const build = sourceOf("src-tauri/build.rs");
    const list = /const WINDOW_COMMANDS: &\[&str\] = &\[([^\]]*)\]/s.exec(build)?.[1] ?? "";
    expect(list, "WINDOW_COMMANDS could not be read out of build.rs").toContain('"save_attachment"');
    expect(list).not.toContain('"open_attachment"');
    expect(sourceOf("../webapp/app/shell/open-attachment.ts")).not.toMatch(/open_attachment"|openAttachmentWithSystemViewer/);
    // The grant stays the main window's and stays one-directional.
    expect(grant.windows).toEqual(["main"]);
    expect(grant.permissions).not.toContain("core:event:allow-emit");
  });

  /**
   * THE SAVE COMMAND'S THREE LISTS, AND THE ONE THAT KILLS THE APP WHEN IT DISAGREES.
   *
   * `build.rs#WINDOW_COMMANDS` declares the permission pair into the ACL manifest, the capability
   * grants the `allow-` half, and the invoke handler registers the function. The failure when the
   * first two disagree is NOT a refused command: tauri resolves a runtime capability with an
   * internal `unwrap()`, and 0.9.7 shipped `allow-open-external`/`allow-open-attachment` granted
   * and undeclared — every install aborted seconds after launch, before the updater could run, so
   * the fleet could not be fixed by shipping again. `engine_tests.rs` holds the pair in Rust; this
   * is its twin here, and it is the one that runs without a Rust toolchain.
   *
   * Asserted as a PROPERTY over the whole grant rather than for `save_attachment` alone — a rule
   * written for one name is a rule the next command is added outside of.
   */
  it("every command the window is granted is declared by the build", () => {
    const build = sourceOf("src-tauri/build.rs");
    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    const grant = JSON.parse(cap![1]!) as { permissions: string[] };

    const declared = [...build.matchAll(/^\s*"([a-z0-9_]+)",\s*$/gm)].map((m) => m[1]!);
    expect(declared, "WINDOW_COMMANDS could not be read out of build.rs").toContain("save_attachment");

    const undeclared = grant.permissions
      .filter((p) => !p.includes(":"))
      .map((p) => p.replace(/^(allow|deny)-/, "").replace(/-/g, "_"))
      .filter((command) => !declared.includes(command));
    expect(undeclared, `granted and never declared — this aborts every install at launch: ${undeclared.join(", ")}`)
      .toEqual([]);

    // …and the save door specifically, at all three of its ends.
    expect(declared).toContain("save_attachment");
    expect(grant.permissions).toContain("allow-save-attachment");
    expect(engine, "save_attachment is not in the invoke handler")
      .toMatch(/generate_handler!\[[^\]]*\bsave_attachment\b/s);
  });

  /**
   * THE SAVE TAKES THE SAME TWO FIELDS AS THE OPEN — a name and bytes, and never a path.
   *
   * It writes into a directory the PERSON owns, which is the one place where a window-supplied
   * path would be worth something to an attacker, so the argument that licensed the open command
   * has to hold here too: the shell picks the folder (`app.path().download_dir()`), sanitises the
   * name and numbers a collision, and the window names none of it.
   */
  it("the save command names an attachment and a file name, and no place on the disk", () => {
    expect(engine).toMatch(/fn save_attachment\(\s*shell: tauri::State<'_, Arc<Shell>>,\s*attachment_id: String,\s*filename: String,\s*\)/);
    expect(engine, "the Downloads folder is not the framework's").toMatch(/download_dir\(\)/);
  });

  it("the shell composes the path and takes no filesystem permission to do it", () => {
    // The preview's command takes an id and a declared type and never a path.
    expect(read_preview()).toMatch(/fn stage_attachment_preview\(\s*shell: tauri::State<'_, Arc<Shell>>,\s*previews: tauri::State<'_, Previews>,\s*attachment_id: String,\s*mime_type: String,\s*\)/);
    // And the grant carries no filesystem plugin permission — the write is this process's own.
    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    const grant = JSON.parse(cap![1]!) as { permissions: string[] };
    expect(grant.permissions.filter((p) => p.startsWith("fs:"))).toEqual([]);
    expect(grant.permissions.filter((p) => p.startsWith("shell:"))).toEqual([]);
    expect(grant.permissions.filter((p) => p.startsWith("dialog:"))).toEqual([]);
  });
});

describe("the window entry arms it", () => {
  const main = sourceOf("src/main.tsx");

  it("`enableDesktopAttachments` is called from the entry, unconditionally", () => {
    // The guard it used to sit inside (`if (__OHMAIL_LOCAL_ENGINE__)`) existed for the retired
    // preview artifact, whose published claim was that it calls no command. The window entry is
    // the engine build's alone now, so the arming is unconditional — outside the app the seam's
    // own no-shell contract is what refuses, not a build-time branch.
    expect(main).toContain("enableDesktopAttachments()");
    expect(main).not.toMatch(/__OHMAIL_LOCAL_ENGINE__/);
  });

  it("and it is armed exactly once", () => {
    expect(main.match(/enableDesktopAttachments\(\)/g) ?? []).toHaveLength(1);
  });
});

describe("the reading pane withholds the in-app viewer for the type this build cannot draw", () => {
  it("MessageFiles asks `opensInSystemViewer` alongside `isPreviewable`", () => {
    // The strip is `MessageFiles`, which every reading pane renders; the pane is held to it.
    const read = (name: string): string => {
      try {
        return readFileSync(resolve(process.cwd(), `apps/webapp/app/shell/${name}`), "utf8");
      } catch {
        return readFileSync(resolve(process.cwd(), `../webapp/app/shell/${name}`), "utf8");
      }
    };
    expect(read("MessagePane.tsx")).toMatch(/<MessageFiles messageId=\{message\.id\} \/>/);
    const pane = read("MessageFiles.tsx");
    expect(pane).toMatch(
      /canPreview=\{\(item\) => isPreviewable\(item\.mimeType\) && !opensInSystemViewer\(item\.mimeType\)\}/,
    );
  });
});
