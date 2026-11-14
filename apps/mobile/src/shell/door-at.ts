/**
 * WHERE THE DOOR OPENS NEXT, when a page asked for it: the open mailbox's page asks for the list of servers. Held in
 * this process and taken once by the door that opens, never a route parameter: the app's scheme is a link any page
 * can follow, and nothing a link names may steer the door.
 */
import type { DoorAt } from "./door-kinds";

let asked: DoorAt | null = null;

export function askDoorAt(at: DoorAt): void {
  asked = at;
}

/** What was asked, once; null where the connection's state decides. */
export function takeDoorAsk(): DoorAt | null {
  const at = asked;
  asked = null;
  return at;
}
