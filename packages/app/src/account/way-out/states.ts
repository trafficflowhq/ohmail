import type { AccountState } from "../contract.js";
import type { WayOutModel, WayOutSection } from "./model.js";

const state = (
  address: string | null,
  section: WayOutSection,
  noBrowser = false,
): AccountState<WayOutModel> => ({
  address,
  model: { section, noBrowser, open: () => {} },
});

/**
 * The card's states. The design draws the card for Devices, Security and Account on a window signed in to an
 * account, and "no browser" once, on Devices; the other two sections' "no browser" are the shipped card's own.
 */
export const WAY_OUT_STATES = {
  devices: state("door=cloud&screen=settings&sec=devices", "devices"),
  devicesNoBrowser: state("door=cloud&screen=settings&sec=devices&state=nobrowser", "devices", true),
  security: state("door=cloud&screen=settings&sec=security", "security"),
  securityNoBrowser: state(null, "security", true),
  account: state("door=cloud&screen=settings&sec=account", "account"),
  accountNoBrowser: state(null, "account", true),
} as const satisfies Record<string, AccountState<WayOutModel>>;
