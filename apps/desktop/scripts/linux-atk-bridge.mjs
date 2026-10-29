/**
 * linux-atk-bridge.mjs — the bundler config that puts the AT-SPI bridge CI builds
 * (`src-tauri/linux/at-spi2-core/build-bridge.sh`, named by OHMAIL_ATK_BRIDGE) into the .deb and the .rpm.
 *
 * libgtk-3 loads libatk-bridge-2.0.so.0 as its own dependency, so the distribution's copy wins unless the
 * binary's DT_RPATH (`src-tauri/build.rs`: $ORIGIN/../lib/ohmail/atk-bridge) names a directory holding ours.
 * The AppImage gets its bridge from the GTK plugin instead, and the Flatpak builds its own in the manifest.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** /usr/bin/ohmail's $ORIGIN/../lib/ohmail/atk-bridge. */
export const PACKAGED_BRIDGE = "/usr/lib/ohmail/atk-bridge/libatk-bridge-2.0.so.0";

/** A `--config` overlay for `tauri build`, or null when there is no bridge to carry. */
export function bridgePackaging({ platform, bridge }) {
  if (platform !== "linux" || !bridge) return null;
  const file = resolve(bridge);
  if (!existsSync(file)) throw new Error(`OHMAIL_ATK_BRIDGE names ${file}, which does not exist`);
  if (!readFileSync(file).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`OHMAIL_ATK_BRIDGE names ${file}, which is not an ELF library`);
  }
  const files = { [PACKAGED_BRIDGE]: file };
  return { bundle: { linux: { deb: { files }, rpm: { files } } } };
}
