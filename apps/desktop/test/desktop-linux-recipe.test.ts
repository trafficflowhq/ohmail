import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE LINUX PACKAGING RECIPE, asserted where it is written.
 *
 * The .deb and the AppImage are assembled by the Tauri bundler, which does two things this
 * repository has to take back:
 *
 *  · it DOWNLOADS linuxdeploy's GTK plugin from a third-party `master` branch at bundle time and
 *    runs whatever it got — so the launcher inside every Linux artifact was written by a branch
 *    nobody here watches; and
 *  · it generates the desktop entry from a built-in template that has no field code on `Exec`,
 *    which makes the entry's own `x-scheme-handler/mailto` claim false.
 *
 * Both are now files in this directory tree, and the build workflow installs the first into the
 * bundler's tools directory before it runs. The artifacts themselves are checked in CI, out of the
 * finished AppImage, which is the assertion that counts — this file is the one that runs on every
 * push, so that the recipe cannot be edited back between releases without something going red
 * where the change is being made.
 *
 * Each expectation below names the machine behaviour it protects. None of them is a style rule.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

const PLUGIN = "src-tauri/linux/linuxdeploy-plugin-gtk.sh";
const ENTRY = "src-tauri/linux/ohmail.desktop";

/**
 * The build workflow, wherever this tree keeps it.
 *
 * This suite is published, so it runs in two checkouts whose layouts differ: the workflow is at
 * `.github/workflows/build.yml` in the published repository and under `public/ohmail/github/` in
 * the private one it is generated from. Both are looked for and exactly one must be there — a
 * lookup that quietly finds neither would turn this into a test that asserts nothing.
 */
function buildWorkflow(): string {
  const root = path.resolve(APP, "..", "..");
  const candidates = [
    path.join(root, ".github", "workflows", "build.yml"),
    path.join(root, "public", "ohmail", "github", "workflows", "build.yml"),
  ];
  const found = candidates.filter((p) => fs.existsSync(p));
  expect(found, `no build workflow at any of ${candidates.join(" or ")}`).not.toHaveLength(0);
  return fs.readFileSync(found[0]!, "utf8");
}

describe("the AppImage's launcher", () => {
  /**
   * THE BLOCKER THIS RECIPE EXISTS FOR.
   *
   * The AppImage deliberately does not bundle the GL stack: libEGL, libGL, libgbm and libdrm are
   * the host's drivers and must stay the host's. But Mesa's `libEGL_mesa.so.0` has a `DT_NEEDED`
   * on `libwayland-client.so.0`, and an AppImage puts its own `usr/lib` ahead of the system path
   * for every process it starts — so the host's driver is loaded against OUR copy of
   * libwayland-client instead of the one it was built against. Where the host's Mesa is newer than
   * the wayland this was built on, the driver cannot load, and the only thing said out loud is
   *
   *     Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
   *
   * from the web process, which then aborts: a window that maps and never renders.
   *
   * The AppImage project's own exclude list has carried this library since 2024 for exactly this
   * reason. The linuxdeploy build the bundler downloads has an older copy of that list compiled
   * into it and deploys the library anyway, which is why the plugin removes it by hand.
   */
  it("does not ship the library the host's EGL driver has to supply", () => {
    const plugin = read(PLUGIN);
    expect(plugin).toMatch(/for excluded in libwayland-client\.so\.0; do/);
    expect(plugin).toMatch(/rm -f "\$found"/);
  });

  /**
   * The removal has to be the LAST thing the plugin does. The plugin ends by calling linuxdeploy
   * again to deploy a further set of libraries, and anything removed before that call can be put
   * back by it. Asserted by position rather than by reading the code, because the ordering is the
   * whole property.
   */
  it("removes it after the last thing that can deploy a library", () => {
    const plugin = read(PLUGIN);
    const nestedDeploy = plugin.lastIndexOf('"$LINUXDEPLOY" --appdir=');
    const removal = plugin.indexOf("for excluded in libwayland-client.so.0");
    expect(nestedDeploy).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(nestedDeploy);
  });

  /**
   * `GDK_BACKEND` is the caller's. Upstream exports `x11` unconditionally, which sends every
   * Wayland session through XWayland — where the window is scaled 1x and reads blurry on a HiDPI
   * display — and overrides a caller who asked for something else. The crash that line cites is a
   * GSettings schema mismatch reported against a GDK two years older than the one bundled here.
   *
   * Asserted against the text the plugin WRITES into the launcher, which is what runs.
   */
  it("leaves the display backend to whoever launches the app", () => {
    expect(read(PLUGIN)).not.toMatch(/^export GDK_BACKEND=/m);
  });

  /**
   * The GTK module search path's system fallback is derived from the same pkg-config answer as the
   * bundled one, so it can never name a different architecture. Upstream spells the x86_64 triple
   * literally, which put `/usr/lib/x86_64-linux-gnu/gtk-3.0` — a directory no arm64 machine has —
   * into the arm64 build.
   */
  it("names no architecture's library directory literally", () => {
    // Comments stripped first: this file explains the fault it is fixing, and naming the triple in
    // prose is how it does that. What must not contain one is the code — and in particular the
    // text written into the launcher, which CI separately reads for foreign triples out of the
    // finished AppImage.
    const code = read(PLUGIN)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/x86_64-linux-gnu/);
  });

  /**
   * The escape hatch. The AppImage's own launcher prepends `$APPDIR/usr/lib` to the library path
   * for everything it starts and nothing downstream can take it back off, so the only way to run
   * against the host's GTK and WebKitGTK is to exec the binary from the hook — which the launcher
   * sources BEFORE it sets anything. That is why the branch has to be the first thing in the hook,
   * asserted here by position: a later one would run with our paths already exported.
   */
  it("can be told to use the host's GTK and WebKitGTK instead", () => {
    const plugin = read(PLUGIN);
    expect(plugin).toMatch(/if \[ -n "\$OHMAIL_SYSTEM_WEBKIT" \]; then/);
    expect(plugin).toMatch(/exec "\$APPDIR\/usr\/bin\/ohmail" "\$@"/);
    const escape = plugin.indexOf('if [ -n "$OHMAIL_SYSTEM_WEBKIT" ]');
    const firstOurPath = plugin.indexOf('export GTK_DATA_PREFIX="$APPDIR"');
    expect(firstOurPath).toBeGreaterThan(-1);
    expect(escape).toBeLessThan(firstOurPath);
  });

  /**
   * And the plugin has to actually reach the bundler. It is used only because it is already at the
   * path the bundler would otherwise download into; a workflow that stopped writing it there would
   * silently go back to the downloaded copy, with every other test here still green.
   */
  it("is installed where the bundler looks, in both Linux jobs", () => {
    const workflow = buildWorkflow();
    const installs = workflow.match(
      /install -m 0755 apps\/desktop\/src-tauri\/linux\/linuxdeploy-plugin-gtk\.sh/g,
    );
    expect(installs).toHaveLength(2);
    expect(workflow).toMatch(/TOOLS="\$\{XDG_CACHE_HOME:-\$HOME\/\.cache\}\/tauri"/);
  });
});

describe("the Linux desktop entry", () => {
  /**
   * THE MAILTO CLAIM, MADE TRUE.
   *
   * The entry declares `x-scheme-handler/mailto`, which is what makes ohmail selectable as the
   * system mail app. Tauri's built-in template writes `Exec=ohmail` with no field code, so the
   * desktop environment launches the app with no argument and the address the person clicked is
   * dropped — the app is wired to receive it (`mailto_link` in the shell, `src/mailto.ts` in the
   * window) and simply never gets one. `%U` rather than `%u` because an activation may carry more
   * than one URL and the shell answers each on its own.
   */
  it("hands the clicked address to the app", () => {
    expect(read(ENTRY)).toMatch(/^Exec=\{\{exec\}\} %U$/m);
  });

  /**
   * The window maps under the binary's name — as the Wayland `app_id`, and as the X11 `WM_CLASS`
   * instance name (X11 also carries the capitalised form as the class; the desktop entry
   * specification lets either match). This is what attributes a running window to this entry
   * rather than drawing a second, unlabelled taskbar icon beside it.
   */
  it("can be matched to the window the app maps", () => {
    expect(read(ENTRY)).toMatch(/^StartupWMClass=\{\{exec\}\}$/m);
  });

  /**
   * The scheme claims come from `plugins.deep-link` and reach the entry through this variable. A
   * template that dropped it would unregister ohmail as a mail app with nothing else noticing.
   */
  it("still carries the scheme claims", () => {
    expect(read(ENTRY)).toMatch(/^MimeType=\{\{mime_type\}\}$/m);
  });

  /**
   * And the bundler has to be pointed at it. The AppImage builds its AppDir from the Debian
   * package's data directory, so this one template is what BOTH Linux artifacts carry — which is
   * why it is configured under `deb` and not somewhere AppImage-shaped.
   */
  it("is the template the bundler is configured to use", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      bundle: { linux: { deb: { desktopTemplate?: string } } };
    };
    const configured = conf.bundle.linux.deb.desktopTemplate;
    expect(configured).toBe("linux/ohmail.desktop");
    expect(fs.existsSync(path.join(APP, "src-tauri", configured!))).toBe(true);
  });
});
