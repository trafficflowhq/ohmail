import { useRef, useState, useSyncExternalStore } from "react";
import { useText } from "@ohmail/app/text";
import { Dialog } from "@ohmail/ui/base";
import { Switcher, type SwitcherProps } from "@ohmail/ui/mail";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import type { OtherAppDoor } from "./other-app";

export function companionSwitch(door: OtherAppDoor, os: ShellConfig["os"]) {
  return function CompanionSwitch({ kind, onRail }: Pick<SwitcherProps, "kind" | "onRail">) {
    const products = useText("frame");
    const t = useText("phoneSettings");
    const state = useSyncExternalStore(door.state.subscribe, door.state.read);
    const [ask, setAsk] = useState(false);
    const [failed, setFailed] = useState(false);
    const pressing = useRef(false);
    async function open() {
      if (pressing.current) return;
      setFailed(false);
      pressing.current = true;
      try {
        if (state === "absent" || await door.open({ to: "last" }) === "absent") setAsk(true);
      } catch {
        setFailed(true);
        setAsk(true);
      } finally {
        pressing.current = false;
      }
    }
    async function get() {
      if (pressing.current) return;
      pressing.current = true;
      try {
        if (await door.get()) setAsk(false);
        else setFailed(true);
      } catch {
        setFailed(true);
      } finally {
        pressing.current = false;
      }
    }
    return (
      <>
        <Switcher kind={kind} current="cal" onRail={onRail}
          label={products("products.label")}
          mail={{ word: "ohmail", label: products("products.mail"), absent: state === "absent" }}
          cal={{ word: "ohcal", label: products("products.cal") }}
          onSwitch={(to) => { if (to === "mail") void open(); }}
        />
        {ask ? (
          <Dialog open title={t("companion.title")} line={t("companion.line")} keysOn="cancel"
            said={failed ? { line: t("companion.failed"), refused: true } : undefined}
            confirm={{ label: t(os === "ios" ? "companion.appStore" : "companion.playStore"), onPress: () => void get() }}
            cancel={{ label: t("companion.cancel") }} onClose={() => setAsk(false)}
          />
        ) : null}
      </>
    );
  };
}
