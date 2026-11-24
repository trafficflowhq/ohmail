/**
 * ONE SENTENCE OVER THE WHOLE SCREEN, where a page of the shell cannot stand: no web view that can carry it, or a page
 * that ended too often. The shell's screen and the door's both say it so.
 */
import { StyleSheet, View } from "react-native";

import { Txt } from "../ui/base";

export function Sentence({ words }: { words: string }) {
  return <View style={styles.over}><Txt variant="body">{words}</Txt></View>;
}

const styles = StyleSheet.create({
  over: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", padding: 24 },
});
