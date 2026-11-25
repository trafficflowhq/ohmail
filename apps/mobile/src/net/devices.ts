import { mintDeviceSettingsHandoff } from "./account";
import type { ConnectedSession } from "./pairing";
import { webAddressOf } from "./update-verbs";

export function accountDevicesOrigin(session: ConnectedSession): string | null {
  const { flavor } = session.profile;
  if (session.standalone || (flavor !== "selfhost" && flavor !== "managed")) return null;
  return webAddressOf(session.profile);
}

/** The handoff reference checks the browser's signed-in account before Settings opens. */
export async function accountDevicesPage(session: ConnectedSession, signal: AbortSignal): Promise<string | null> {
  const base = accountDevicesOrigin(session);
  if (!base) return null;
  const reference = await mintDeviceSettingsHandoff(session, signal);
  if (reference === null) return null;
  const page = new URL("/", base);
  page.searchParams.set("settingsHandoff", reference);
  page.hash = "/settings/devices";
  return page.href;
}
