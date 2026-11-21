import { useEffect, useRef, useState } from "react";
import type { ScreenerOhbox } from "@ohmail/app/settings/screener";
import { NONE, type HostWires, type Payloads } from "@ohmail/app/host";
import { useTravelledChange } from "../../shell/travelled-change";

export function useOhboxPreference(wire: HostWires["screening"]): ScreenerOhbox | null {
  const [preference, setPreference] = useState<Payloads.ScreeningPreference | null>(null);
  const alive = useRef(false);
  const { heard, note, clear } = useTravelledChange({
    reread: () => wire === NONE ? Promise.reject(new Error("Screening is unavailable")) : wire.read(),
    onRead: setPreference,
  });
  useEffect(() => {
    alive.current = true;
    let current = true;
    if (wire !== NONE) void wire.read().then((row) => {
      if (current) { setPreference(row); heard(row, false); }
    }).catch(() => { if (current) setPreference(null); });
    return () => { current = false; alive.current = false; };
  }, [wire, heard]);

  if (wire === NONE || !preference) return null;
  const write = async (next: Payloads.ScreeningChange) => {
    try {
      const row = await wire.change(next);
      if (!alive.current) return { bar: row.ohboxBar, travelled: false };
      setPreference(row);
      return { bar: row.ohboxBar, travelled: heard(row, true) };
    } catch (err) {
      if (alive.current) clear();
      throw err;
    }
  };
  return {
    relevant: preference.ohboxPolicy === "people_only",
    impersonation: preference.impersonationFiling ?? null,
    bar: preference.ohboxBar, defaultBar: preference.defaultBar, note,
    change: async ({ relevant, impersonation }) => (await write({
      ...(relevant === undefined ? {} : { ohboxPolicy: relevant ? "people_only" : "people_and_replied" }),
      ...(impersonation === undefined ? {} : { impersonationFiling: impersonation }),
    })).travelled,
    saveBar: (ohboxBar) => write({ ohboxBar }),
  };
}

export { useFiledLetters } from "@ohmail/app/settings/screener";
