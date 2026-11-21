import { createContext, useContext, useState, type ReactNode } from "react";

const Slot = createContext<HTMLDivElement | null | undefined>(undefined);

export function AfterComposerTextSlot({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <Slot.Provider value={target}>
      {children}
      <div ref={setTarget} className="oh-composer-after-text" />
    </Slot.Provider>
  );
}

/** The slot after the editor body and before the signature. */
export function useAfterComposerTextTarget(): HTMLDivElement | null | undefined {
  return useContext(Slot);
}
