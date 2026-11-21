"use client";

import { createContext } from "react";

/** The session check can identify the account when the document has no account marker. */
export const ConfirmBrowserFaceOwner = createContext<(owner: string) => void>(() => {});
