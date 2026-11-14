/**
 * THE PAGE'S FIRST MODULE, imported before every other: the bridge, and the words door installed on
 * the page's storage before anything else can write to it.
 */
import { createBridge, note, type Bridge } from "./bridge";
import { installKeptStorage, type KeptStorage } from "./kept-storage";
import { pagePort } from "./port";

const epoch = new URLSearchParams(location.search).get("epoch") ?? "";
const port = pagePort();

export const bridge: Bridge | null = port && epoch ? createBridge(port, epoch) : null;

export const kept: KeptStorage | null = bridge === null ? null : installKeptStorage(
  localStorage,
  (key, value) => bridge.request("keep", { key, value }).then((a) => a.kept),
  () => note(bridge, "keeperRefused"),
);
