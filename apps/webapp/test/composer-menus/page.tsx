import { useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Report } from "@ohmail/ui/base";
import { TextProvider } from "@ohmail/app/text";
import { Composer, Recipients, Sheet } from "@ohmail/ui/mail";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import "../../../../packages/app/src/reader/column.css";
import "../../../../packages/app/src/frame/placement.css";
import frame from "../../../../packages/app/messages/frame.en.json";
import write from "../../../../packages/app/messages/write.en.json";
import { Columns } from "../../../../packages/app/src/frame/Columns.js";
import { layoutPlan } from "../../../../packages/app/src/frame/layout-plan.js";
import { useFromLine } from "../../../../packages/app/src/write/head/From.js";
import { WriteAbove } from "../../../../packages/app/src/write/above.js";
import type { WriteBeside, Writing } from "../../../../packages/app/src/write/ports.js";
import { Later } from "../../../../packages/app/src/write/verbs/Later.js";
import { Verbs } from "../../../../packages/app/src/write/verbs/Verbs.js";

const scene = new URLSearchParams(location.search);

const senders = Array.from({ length: 40 }, (_, index) => ({
  id: String(index + 1),
  address: `sender-${index + 1}@example.com`,
  sendable: true,
  connected: true,
  maxMessageBytes: null,
}));

const later: WriteBeside["later"] = {
  options: () => [],
  floor: (now) => now,
  label: (at) => at,
  seed: () => "2099-01-01T12:00",
  compose: (value) => ({ at: new Date(value).toISOString(), shifted: null }),
  zone: () => "UTC",
  useFiles: () => null,
};

function Reply() {
  const [sender, setSender] = useState(senders[0]!);
  const [typed, setTyped] = useState("");
  const [schedule, setSchedule] = useState<HTMLElement | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const compact = document.documentElement.dataset.device === "phone" || scene.has("compact");
  const from = useFromLine(
    {
      address: sender.address,
      mailboxId: sender.id,
      choices: senders,
      substituted: false,
      substitutedFrom: null,
      domainMatched: false,
      maxMessageBytes: null,
    },
    false,
    (id) => setSender(senders.find((entry) => entry.id === id)!),
  );
  const foot = (
    <Verbs
      canSend
      compact={compact}
      going={false}
      discardHeld={false}
      onSend={() => {}}
      onDiscard={() => {}}
      later={{ open: schedule !== null, onPress: setSchedule }}
    />
  );
  return (
    <>
      <Sheet
        kind="reading"
        label="Reading"
        scrollLabel="Conversation"
        foot={foot}
        flushFoot
        head={scene.has("lower") ? <div style={{ height: 520 }}>Earlier message</div> : undefined}
      >
        <div className="rd-reply">
          <Composer
            reply
            label="Reply"
            foot={{ label: "Writing tools" }}
            head={
              <Recipients
                from={from}
                reply
                lines={[{ id: "to", label: "To", people: [], typed }]}
                onType={(_, value) => setTyped(value)}
                suggest={{
                  label: "Address suggestions",
                  people: () =>
                    Array.from({ length: 18 }, (_, index) => ({
                      id: String(index + 1),
                      name: `Contact ${index + 1}`,
                      address: `contact-${index + 1}@example.com`,
                    })),
                  onTake: (_, person) => setTyped(person.address),
                }}
              />
            }
          >
            <p>Thanks for the update.</p>
          </Composer>
        </div>
      </Sheet>
      <Later
        anchor={schedule}
        onClose={() => setSchedule(null)}
        onPick={() => setScheduled(true)}
        forward={false}
        hasFiles={false}
        attaching={[]}
      />
      {scheduled ? <output aria-label="Schedule result">Scheduled</output> : null}
    </>
  );
}

function Frame() {
  const [undone, setUndone] = useState(false);
  const scope = scene.get("scope");
  const report = scene.has("report") && !undone;
  if (!scope && !scene.has("report")) return <Reply />;
  return (
    <div className="fr-root">
      <div className="fr-frame" data-rail="dock" data-letter="">
        {scope === "phone" ? (
          <Columns
            plan={layoutPlan({
              width: innerWidth,
              height: innerHeight,
              pointer: "coarse",
              posture: "flat",
              reducedMotion: true,
            })}
            list={null}
            listKeys={false}
            rail={null}
            wide={null}
            above={null}
            labels={{
              list: "List",
              reading: "Reading column",
              railWidth: "Rail width",
              listWidth: "List width",
            }}
            reading={<Reply />}
          />
        ) : (
          <section
            className="rd-column"
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            role={scope ? "dialog" : undefined}
            aria-modal={scope ? true : undefined}
            aria-label={scope ? "Reply run" : undefined}
          >
            <Reply />
          </section>
        )}
        <div className="fr-report" data-popover-avoid="">
          {report ? (
            <Report undo={{ label: "Undo", onPress: () => setUndone(true) }}>Draft discarded</Report>
          ) : null}
        </div>
        {undone ? <output aria-label="Undo result">Draft restored</output> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={{ ...frame, ...write }} timeZone="UTC">
    <portalRenderer.Provider value={createPortal}>
      <WriteAbove writing={{} as Writing} beside={{ later } as WriteBeside}>
        <Frame />
      </WriteAbove>
    </portalRenderer.Provider>
  </TextProvider>,
);
