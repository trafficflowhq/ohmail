"use client";

import { useRef } from "react";
import type { ConnectKept, ConnectTyped } from "./types.js";

/**
 * THE TYPED WORDS, KEPT BY A CALLER THAT OUTLIVES THE FORM: a wizard whose other steps unmount it hands this to the
 * form, and a trip to another step keeps what was typed. One object for the caller's life, in memory alone: nothing
 * of it is stored. It never holds the password, which leaves with the field it was typed into.
 */
export function useConnectKept(): ConnectKept {
  const holder = useRef<ConnectKept | null>(null);
  if (holder.current === null) {
    let typed: ConnectTyped | null = null;
    holder.current = {
      read: () => typed,
      write: (next) => {
        typed = next;
      },
    };
  }
  return holder.current;
}
