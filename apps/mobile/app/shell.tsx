/**
 * The shell's route: the web view with the shared views, while the connection holds a shell
 * session, below the status bar (the page is handed the other edges as facts). Anything else is
 * the gate's to place, so this route sends it back to the root. Under the shell's own boundary,
 * as every route stands under one.
 */
import { Redirect } from "expo-router";
import { View } from "react-native";

import { useConnection } from "../src/net/connection";
import { ShellScreen } from "../src/shell/ShellScreen";
import { useTopPad } from "../src/ui/base";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

export default function Shell() {
  return (
    <SurfaceBoundary surface="shell">
      <ShellRoute />
    </SurfaceBoundary>
  );
}

function ShellRoute() {
  const conn = useConnection();
  const pad = useTopPad(0);
  if (conn.state.k !== "shell") return <Redirect href="/" />;
  return (
    <View style={{ flex: 1, paddingTop: pad }}>
      <ShellScreen key={conn.state.session.ownerKey} session={conn.state.session} />
    </View>
  );
}
