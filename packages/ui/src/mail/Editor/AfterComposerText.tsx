import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

/** Controls owned by the editor, laid out after its body and before the signature. */
export function AfterComposerText({ children }: { children: ReactNode }) {
  const target = useContext(Slot);
  if (target === undefined) return children;
  return target === null ? null : createPortal(children, target);
}
