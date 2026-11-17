/**
 * The door's route: the page that stands while no mailbox is open (the ways in, the list of servers), and over an
 * open one when its page asks for the list. Below the status bar, as the shell's route is; the page is handed the
 * other edges as facts. Only a build that shows mail in the shell has a door: on its own screens the app's ways in
 * are those screens, so this route sends it back to the root.
 */
import { Redirect } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { MAIL_SURFACE } from "../src/net/connection";
import { takeDoorAsk } from "../src/shell/door-at";
import { DoorScreen } from "../src/shell/DoorScreen";
import { useTopPad } from "../src/ui/base";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

export default function Door() {
  /* Under the boundary, as every route stands under one; the build decides, so a screens build never mounts the door. */
  return (
    <SurfaceBoundary surface="shell">
      {MAIL_SURFACE === "shell" ? <DoorRoute /> : <Redirect href="/" />}
    </SurfaceBoundary>
  );
}

function DoorRoute() {
  const pad = useTopPad(0);
  /* Where a page asked the door to open, taken once at this mount; never read from the route. */
  const [asked] = useState(takeDoorAsk);
  return (
    <View style={{ flex: 1, paddingTop: pad }}>
      <DoorScreen asked={asked} />
    </View>
  );
}
