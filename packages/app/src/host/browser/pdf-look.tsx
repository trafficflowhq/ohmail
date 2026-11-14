import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { PdfLook } from "../../reader/look/FilePreview.js";
import { useText } from "../../text/index.js";

type Instance = { blob: Blob | undefined; key: number };
type Reply = { page: number; total: number };
type Pipe = { instance: Instance; port: MessagePort; timer: ReturnType<typeof setTimeout>; target: number };

function closePipe(pipe: Pipe) {
  clearTimeout(pipe.timer);
  pipe.port.close();
}

export const usePdfLook: PdfLook = (blob) => {
  const t = useText("attachmentPreview");
  const [instance, setInstance] = useState<Instance>({ blob, key: 0 });
  const [answer, setAnswer] = useState<{ from: Instance; reply: Reply | "failed" } | null>(null);
  const pipe = useRef<Pipe | null>(null);
  if (instance.blob !== blob) setInstance({ blob, key: instance.key + 1 });

  useEffect(
    () => () => {
      const current = pipe.current;
      if (current?.instance !== instance) return;
      closePipe(current);
      pipe.current = null;
    },
    [instance],
  );

  const reply = answer?.from === instance ? answer.reply : null;
  const connect = ({ currentTarget }: SyntheticEvent<HTMLIFrameElement>) => {
    const target = currentTarget.contentWindow;
    if (!blob || !target || pipe.current?.instance === instance) return;
    if (pipe.current) closePipe(pipe.current);
    const { port1, port2 } = new MessageChannel();
    const fail = () => {
      if (pipe.current !== current) return;
      closePipe(current);
      setAnswer({ from: instance, reply: "failed" });
    };
    const timer = setTimeout(fail, 8_000);
    const current = { instance, port: port1, timer, target: 1 };
    pipe.current = current;
    let ready = false;
    port1.onmessage = ({ data }) => {
      if (pipe.current !== current) return;
      if (data === "ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        void blob.arrayBuffer().then((bytes) => {
          if (pipe.current === current) port1.postMessage(bytes, [bytes]);
        }, fail);
      } else if (data === "failed") {
        fail();
      } else if (
        ready &&
        data &&
        Number.isSafeInteger(data.page) &&
        Number.isSafeInteger(data.total) &&
        data.page > 0 &&
        data.page <= data.total
      ) {
        setAnswer({ from: instance, reply: { page: data.page, total: data.total } });
      }
    };
    // A sandboxed frame has no target origin. The connection is sent to this window only.
    target.postMessage("pdf-preview", "*", [port2]);
  };

  return {
    page: reply && reply !== "failed" ? reply.page : 1,
    total: reply && reply !== "failed" ? reply.total : 0,
    step: (delta) => {
      const current = pipe.current;
      if (current?.instance !== instance || !reply || reply === "failed") return;
      current.target = Math.min(reply.total, Math.max(1, current.target + delta));
      current.port.postMessage(current.target);
    },
    content:
      reply === "failed" ? (
        <p role="status">{t("pdfErrorTitle")}</p>
      ) : (
        <>
          {reply === null ? <p role="status">{t("rendering")}</p> : null}
          <iframe
            key={instance.key}
            src="/pdf-preview.html"
            title={t("ariaLabel")}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            tabIndex={-1}
            onLoad={connect}
          />
        </>
      ),
  };
};
