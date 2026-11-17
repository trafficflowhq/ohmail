"use client";

/**
 * THE ACCOUNT WAS DELETED ELSEWHERE, as the web serves it: the wall's page in its erased state. The copy in this
 * browser is already being dropped (`erased-door.ts`); `blocked` says when another tab still holds it open. The way on
 * is a full page load, which starts from a clean module state.
 */
import { WallPage, type WallDoor } from "@ohmail/app/doors/wall";
import { WebDoor } from "../door-device";

const nothing = (): void => {};

export function ErasedRoute({ blocked }: { blocked: boolean }) {
  const door: WallDoor = {
    state: { at: "erased", blocked },
    home: () => { window.location.assign("/"); },
    wayBack: nothing,
    checkAgain: nothing,
    moveOut: nothing,
    guide: nothing,
    deleteNow: nothing,
    signOut: nothing,
    changePassword: () => {},
  };
  return (
    <WebDoor>
      <WallPage door={door} />
    </WebDoor>
  );
}
