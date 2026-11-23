import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Blank, Button, Sentence } from "@ohmail/ui/base";
import { SettingActs, SettingNote } from "@ohmail/ui/mail";
import { isProtonAddress } from "@ohmail/app-logic/mailboxes/connect/providers";
import type { Drawn } from "./drawn.js";
import type { ConnectFormProps } from "./contract.js";
import { WaysOut } from "./Lines.js";
import { ProviderTiles } from "./ProviderTiles.js";

export function ProviderChoice({
  drawn,
  page,
  onPick,
  returning,
}: {
  drawn: Drawn;
  page: NonNullable<ConnectFormProps["page"]>;
  onPick: (manual: boolean) => void;
  returning: RefObject<boolean>;
}): ReactNode {
  const { form, text, door, say, words, ask } = drawn;
  const [typed, setTyped] = useState(form.state.typed.address);
  const [bridge, setBridge] = useState(false);
  const standalone = ask.purpose.kind === "standalone";
  const picker = text("providerPicker");
  const query = typed.trim().toLowerCase();
  const address = query.includes("@");
  const matching = address
    ? form.preset
    : form.presets.find((preset) => preset.label.toLowerCase().includes(query));
  const tiles = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!returning.current) return;
    returning.current = false;
    tiles.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
  }, [returning]);
  if (bridge) {
    const pickAnother = () => setBridge(false);
    return page(
      <div className="mbx-connect-part" data-page-filling-form="">
        <div data-page-form-sentence="">
          <Sentence size="xl" level={1} end="hot">
            {picker("protonShort")}
          </Sentence>
        </div>
        <SettingNote>
          {picker(door.localServerWait ? "protonNoteDesktop" : "protonNote", { other: picker("otherLabel") })}
        </SettingNote>
        <div data-page-form-submit="">
          <SettingActs>
            <Button size="l" onPress={pickAnother}>
              {text("phoneDoor")("form.pickAnother")}
            </Button>
          </SettingActs>
        </div>
      </div>,
      pickAnother,
    );
  }
  return page(
    <>
      <ProviderTiles
        ref={tiles}
        form={form}
        picker={picker}
        bridgeHere={door.localServerWait}
        query={address ? "" : query}
        onPick={onPick}
        onBridge={standalone ? () => setBridge(true) : undefined}
        compact={!standalone}
      />
      <WaysOut d={drawn} showLater={false} />
    </>,
    null,
    <span onBlur={form.lookUp}>
      <Blank
        label={say(words.address)}
        placeholder=""
        size={5}
        value={typed}
        onChange={(value) => {
          setTyped(value);
          const nextAddress = value.includes("@") ? value : "";
          if (nextAddress !== form.state.typed.address) form.type("address", nextAddress);
        }}
        onEnter={() => {
          if (standalone && isProtonAddress(query)) return setBridge(true);
          if (!matching) return form.lookUp();
          form.choose(matching.id);
          onPick(matching.manual === true);
        }}
      />
    </span>,
    ask.later,
  );
}
