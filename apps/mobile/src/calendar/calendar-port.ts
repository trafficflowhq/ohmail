/** Native calendar operations for the connection and the authenticated phone bridge. */
export interface CalendarNative {
  keep(pairing: string, record: string, publication?: string): Promise<boolean>;
  recordPath(pairing: string): string;
  setLive(instance: string | null): Promise<boolean>;
  /** Revoke the current snapshot, then issue permission for exactly one replacement. */
  clear(instance: string, publication: string): Promise<boolean>;
  forget(instance: string): Promise<boolean>;
  target(instance: string, generation: string): { event: string; startMs: number } | null;
  permission?(): Promise<"granted" | "denied" | "default">;
  request?(): Promise<"granted" | "denied">;
}
