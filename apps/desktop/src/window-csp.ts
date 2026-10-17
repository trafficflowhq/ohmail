/**
 * THE MAIN WINDOW'S CONTENT POLICY, stated once. The base config (`src-tauri/tauri.conf.json`), the
 * three platform overlays Tauri merges onto it at build time (`tauri.<os>.conf.json`) and the
 * document's own meta (written by the build, `vite.config.ts`) are all this; Tauri's header and the
 * built meta are enforced together, so they must agree (`desktop-shell.test.ts`).
 * `connect-src` is the one directive that varies: one source, the spelling the platform's webview uses
 * for Tauri's in-process command scheme. On Windows that is `http://ipc.localhost`, which CSP also
 * matches as `https://ipc.localhost`: a loopback address nothing in the app serves. The base and any
 * platform not named here keep `'none'`, where commands fall back to the slower JSON channel.
 */

/** Tauri's command scheme as each webview spells it (`core.js` `convertFileSrc`; WebView2 serves a
 *  custom scheme as `http://<scheme>.localhost`). `prefix` is exactly what the runtime composes. */
export interface CommandChannel {
  source: string;
  prefix: string;
}

const IPC_SCHEME: CommandChannel = { source: "ipc:", prefix: "ipc://localhost/" };
const IPC_WINDOWS: CommandChannel = { source: "http://ipc.localhost", prefix: "http://ipc.localhost/" };

/** The command channel of a platform as `process.platform` spells it, or null: the closed branch. */
export function commandChannelOf(platform: string | null): CommandChannel | null {
  switch (platform) {
    case "linux":
    case "darwin":
      return IPC_SCHEME;
    case "win32":
      return IPC_WINDOWS;
    default:
      return null;
  }
}

/** The policy for `platform` (null: the base). The meta form drops `frame-ancestors`, which a
 *  `<meta>` is specified to ignore; the header carries it. */
export function cspFor(platform: string | null, where: "header" | "meta" = "header"): string {
  const connect = commandChannelOf(platform)?.source ?? "'none'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: attachment-preview: http://attachment-preview.localhost",
    "font-src 'self'",
    `connect-src ${connect}`,
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(where === "header" ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}

const META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/g;

/** `index.html` with its one meta rewritten for `platform`. The source must carry the closed policy
 *  exactly, so a build that skips this step ships `'none'` (slow, never open), and a drifted source
 *  fails the build instead of shipping a policy nobody stated. */
export function withWindowCsp(html: string, platform: string): string {
  const found = [...html.matchAll(META)];
  if (found.length !== 1 || found[0]![1] !== cspFor(null, "meta")) {
    throw new Error(
      "index.html must carry exactly one Content-Security-Policy meta, the closed policy cspFor(null) " +
        "states — see apps/desktop/src/window-csp.ts",
    );
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(platform, "meta")}" />`;
  return html.replace(found[0]![0], () => meta);
}
