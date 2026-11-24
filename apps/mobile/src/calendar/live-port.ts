import type { ServerProfileStore } from "../state/servers";
import type { CalendarNative } from "./calendar-port";

type NativeLifecycle = Pick<CalendarNative, "setLive" | "forget">;

/** The connection revokes admission before awaiting a native cleanup. */
export class CalendarAdmission {
  private current: { instance: string; ready: boolean } | null = null;

  allows(instance: string): boolean {
    return this.current?.instance === instance && this.current.ready;
  }

  async open(native: NativeLifecycle, instance: string): Promise<void> {
    const opening = { instance, ready: false };
    this.current = opening;
    const ready = await native.setLive(instance);
    if (this.current === opening) opening.ready = ready;
  }

  async close(native: NativeLifecycle): Promise<boolean> {
    this.current = null;
    return native.setLive(null);
  }

  async revoke(native: NativeLifecycle, instance: string): Promise<boolean> {
    if (this.current?.instance === instance) this.current = null;
    return native.forget(instance);
  }
}

/** The selected profile can recover only after every durable account wipe has settled. */
export async function calendarProfileMayRecover(
  profiles: Pick<ServerProfileStore, "active" | "pendingWipes">, instance: string,
): Promise<boolean> {
  return (await profiles.active())?.id === instance && (await profiles.pendingWipes()).length === 0;
}
