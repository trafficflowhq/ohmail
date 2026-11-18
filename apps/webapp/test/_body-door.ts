import type { EngineMessage } from "@ohmail/wire";
import * as React from "react";
import { bodyOf, type OhmailEngine } from "@ohmail/client-engine";
import { MessageChromeProvider, type BodyTarget } from "../app/shell/message-chrome.js";

/**
 * THE SHELL'S BODY DOOR FOR A VIEW MOUNTED WITHOUT THE SHELL — `AppShell`'s `bodyOfMessage` over
 * the mirror's own row. The held preview draws through the chrome (`useDrawnBody`), so a bare
 * Screener mount draws a body only through this.
 */
export function withBodyDoor(engine: OhmailEngine, children: React.ReactNode): React.ReactElement {
  const door = (m: BodyTarget) => bodyOf(engine.read(), engine.read().get<EngineMessage>("message", m.id) ?? m);
  return React.createElement(MessageChromeProvider as never, {
    value: { bodyOf: door, hydrateBody: () => {}, hydrateThread: () => {}, conversationOf: () => [] },
    children,
  } as never);
}
