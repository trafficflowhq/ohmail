import { useState } from "react";
import { Button, Dialog } from "@ohmail/ui/base";
import type { CalendarGuest } from "../frame/commands.js";
import { useText } from "../text/index.js";

type Step = "offered" | "selected" | "confirming";

export function useDraftInvitation(contact: CalendarGuest | null) {
  const [guest] = useState(() => contact);
  const [step, setStep] = useState<Step>("offered");

  function needsConfirmation(confirmed?: CalendarGuest): boolean {
    if (confirmed) return step !== "confirming" || confirmed !== guest;
    if (!guest || step === "offered") return false;
    setStep("confirming");
    return true;
  }

  return { guest, step, setStep, needsConfirmation };
}

export function DraftInvitation({
  invitation: { guest, step, setStep },
  onConfirm,
}: {
  invitation: ReturnType<typeof useDraftInvitation>;
  onConfirm: (guest: CalendarGuest) => void;
}) {
  const t = useText("calmail");
  if (!guest) return null;
  const name = guest.name || guest.address;
  if (step === "offered") {
    return (
      <Button kind="two" size="s" onPress={() => setStep("selected")}>
        {t("inviteGuest", { name })}
      </Button>
    );
  }
  const back = () => setStep("selected");
  return (
    <>
      <p>
        {t("guest", { name })}
        <Button kind="quiet" size="s" icon="x" label={t("removeGuest")} onPress={() => setStep("offered")} />
      </p>
      <Dialog
        open={step === "confirming"}
        product="cal"
        title={t("confirmGuest", { name })}
        keysOn="cancel"
        onClose={back}
        cancel={{ label: t("cancelGuest") }}
        confirm={{
          label: t("sendGuest"),
          onPress: () => {
            back();
            onConfirm(guest);
          },
        }}
      />
    </>
  );
}
