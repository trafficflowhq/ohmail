"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

/** the three behaviours, in order: a typo, a scoped query, a tag */
const STEPS = [
  { q: "q1", chip: "q1Chip", note: "q1Note", ms: "q1Ms", count: "q1Count", hits: [["q1HitA", "q1HitAMeta"]] },
  { q: "q2", chip: "q2Chip", note: "q2Note", ms: "q2Ms", count: "q2Count", hits: [["q2HitA", "q2HitAMeta"]] },
  {
    q: "q3",
    chip: "q3Chip",
    note: "q3Note",
    ms: "q3Ms",
    count: "q3Count",
    hits: [
      ["q3HitA", "q3HitAMeta"],
      ["q3HitB", "q3HitBMeta"],
    ],
  },
] as const;

const TYPE_MS = 58; //    per character
const SETTLE_MS = 300; // between the last keystroke and the answer
const HOLD_MS = 3400; //  how long an answer stays up
const CLEAR_MS = 420; //  empty field between behaviours

/**
 * "Fast is a feature", demonstrated instead of asserted: the query types
 * itself, the answer lands with its millisecond count, and the panel cycles
 * through the three things the search can actually do — tolerate a typo,
 * take a scope (`from:`), and read a tag across every mailbox.
 *
 * It runs only while on screen (an offscreen loop is a battery bug), and it
 * starts from a complete final frame — the server render, the no-JS render
 * and the reduced-motion render are all that frame, never an empty field.
 * Reduced motion additionally lists all three behaviours, since it will
 * never see them play.
 */
export function SearchDemo() {
  const t = useTranslations("fast");
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(t("q1").length);
  const [answered, setAnswered] = useState(true);
  const [reduced, setReduced] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  /* the queries the timeline types, read through a ref so the effect can run
     exactly once — a translator function is not guaranteed to be stable, and
     an effect that both sets state and depends on it would never settle */
  const queries = useRef<string[]>([]);
  queries.current = STEPS.map((s) => t(s.q));

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReduced(true);
      return;
    }
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    let timer = 0;
    let alive = true;
    /* one behaviour, start to finish; `next` re-enters with the next one */
    const play = (i: number) => {
      const query = queries.current[i] ?? "";
      setStep(i);
      setAnswered(false);
      setTyped(0);
      let n = 0;
      const tick = () => {
        if (!alive) return;
        n += 1;
        setTyped(n);
        if (n < query.length) {
          timer = window.setTimeout(tick, TYPE_MS);
        } else {
          timer = window.setTimeout(() => {
            if (!alive) return;
            setAnswered(true);
            timer = window.setTimeout(() => {
              if (!alive) return;
              setAnswered(false);
              setTyped(0);
              timer = window.setTimeout(() => play((i + 1) % STEPS.length), CLEAR_MS);
            }, HOLD_MS);
          }, SETTLE_MS);
        }
      };
      timer = window.setTimeout(tick, TYPE_MS);
    };

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible && !alive) {
          alive = true;
          play(0);
        } else if (!visible && alive) {
          alive = false;
          window.clearTimeout(timer);
        }
      },
      { threshold: 0.35 },
    );
    alive = false; //  the observer's first callback starts it
    io.observe(el);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, []);

  const cur = STEPS[step]!;
  const query = t(cur.q);

  return (
    <div className="l-search" ref={boxRef} role="group" aria-label={t("searchAria")}>
      <div className="l-search-field">
        <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.4" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <span className="l-search-q">
          {query.slice(0, typed)}
          <i className="l-search-caret" aria-hidden="true" />
        </span>
      </div>

      <div className="l-search-out" data-show={answered ? "" : undefined}>
        <p className="l-search-meta">
          <span className="l-search-chip">{t(cur.chip)}</span>
          <span className="num">
            {t(cur.count)} · {t(cur.ms)}
          </span>
        </p>
        <ul className="l-search-hits">
          {cur.hits.map(([title, meta]) => (
            <li key={title}>
              <b>{t(title)}</b>
              <span className="num">{t(meta)}</span>
            </li>
          ))}
        </ul>
        <p className="l-search-note">{t(cur.note)}</p>
      </div>

      {reduced ? (
        <div className="l-search-ways">
          <b>{t("waysTitle")}</b>
          <ul>
            {STEPS.map((s) => (
              <li key={s.q}>
                <b>{t(s.q)}</b>
                <span>{t(s.note)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
