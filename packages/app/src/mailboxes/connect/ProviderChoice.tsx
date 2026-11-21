import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Blank } from "@ohmail/ui/base";
import type { Drawn } from "./drawn.js";
import type { ConnectFormProps } from "./contract.js";
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
  return page(
    <ProviderTiles
      ref={tiles}
      form={form}
      picker={text("providerPicker")}
      bridgeHere={door.localServerWait}
      query={address ? "" : query}
      onPick={onPick}
    />,
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
          if (!matching) return form.lookUp();
          form.choose(matching.id);
          onPick(matching.manual === true);
        }}
      />
    </span>,
    ask.later,
  );
}
