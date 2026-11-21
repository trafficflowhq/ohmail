/**
 * THE DOOR'S PAGE: the shell's second start page, run from the app's own files while no mailbox is open (the ways
 * in, the list of servers) and over an open one for its list. It has no scope, so it has no engine, no keeper and no
 * storage: it imports none of the scoped page's start (`../boot`), engine, kept stores or storage owner, and what it
 * draws it draws from what native last said. It asks native what it is, stands the doors' stage, and draws the page
 * its route names.
 */
import { useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import { DoorStage, type DoorDevice } from "@ohmail/app/doors/stage";
import { NONE } from "@ohmail/app/host/contract";
import { browserWindowFacts } from "@ohmail/app/host/browser";
import { fillOver, TextProvider } from "@ohmail/app/text";
import { systemAppearance } from "../frame-supplies";
import { pagePort } from "../port";
import { createDoorBridge, type DoorBridge } from "./bridge";
import catalogue from "./catalogue";
import { doorHandle, type DoorHandle } from "./handle";
import { pages } from "./pages";

/** The document's own element: the stage stamps the look's attributes there and takes them back. */
function device(win: Window): DoorDevice {
  const root = win.document.documentElement;
  return {
    window: browserWindowFacts(win),
    appearance: systemAppearance(win),
    root: {
      read: (name) => root.getAttribute(name),
      write: (name, value) => {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      },
    },
  };
}

function Door({ door, made }: { door: DoorHandle; made: () => DoorDevice }) {
  const route = useSyncExternalStore(door.route.subscribe, door.route.read);
  useEffect(() => {
    // Told once, when the first frame has been drawn: native lifts its cover.
    const frame = requestAnimationFrame(() => void door.ask("ready", {}).catch(() => {}));
    return () => cancelAnimationFrame(frame);
  }, [door]);
  const Page = pages[route];
  const messages = door.config.language === "de" ? fillOver(catalogue.en, catalogue.de) : catalogue.en;
  return (
    <TextProvider locale={door.config.language} messages={messages} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}>
      <DoorStage device={made}>{Page === NONE ? null : <Page door={door} />}</DoorStage>
    </TextProvider>
  );
}

async function start(bridge: DoorBridge, element: HTMLElement): Promise<void> {
  const config = await bridge.request("config", {});
  const door = doorHandle(bridge, config);
  let held: DoorDevice | null = null;
  createRoot(element).render(
    <portalRenderer.Provider value={createPortal}>
      <Door door={door} made={() => (held ??= device(window))} />
    </portalRenderer.Provider>,
  );
}

const epoch = new URLSearchParams(location.search).get("epoch") ?? "";
const port = pagePort();
const element = document.getElementById("root");
if (port && epoch && element) void start(createDoorBridge(port, epoch), element);
