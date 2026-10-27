"use client";

/**
 * THE COMPOSE DOOR — what the rail's Compose, the `c` key, the palette's New message and the
 * desktop menu's Compose do. The shell registers it (`shell-compose.ts`): a letter whose send is on
 * its way gives way to a new one only once a row holds its words. Before the shell has mounted, or
 * on a surface without one, it is the route.
 */
import { go } from "./routing";

let door: (() => void) | null = null;

export function setComposeDoor(fn: (() => void) | null): void {
  door = fn;
}

export function goCompose(): void {
  if (door !== null) door();
  else go("compose");
}
