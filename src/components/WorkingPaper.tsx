"use client";

import { useState } from "react";
import type { SerialisedStep } from "../engine/trace";
import type { Currency } from "../engine/money";
import { money, percent, stepValue } from "../lib/format";

/**
 * The worked computation, set the way an accountant sets one: a hanging line
 * number, the label, a dotted leader, and the figure in a single money column
 * that every other figure on the page aligns to. The line that carries the
 * answer gets a rule above it.
 */

function Bands({
  step,
  currency,
  locale,
}: {
  step: SerialisedStep;
  currency: Currency;
  locale?: string;
}) {
  if (!step.bands || step.bands.length === 0) return null;
  const total = step.bands.reduce((acc, b) => acc + Number(b.tax), 0);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[24rem] text-xs">
        <thead>
          <tr className="eyebrow" style={{ fontSize: "0.625rem" }}>
            <th className="py-1 text-left font-medium">Band</th>
            <th className="py-1 text-right font-medium">Rate</th>
            <th className="py-1 text-right font-medium">In band</th>
            <th className="py-1 text-right font-medium">Tax</th>
          </tr>
        </thead>
        <tbody className="f-figure">
          {step.bands.map((b, i) => (
            <tr key={i} className="border-t border-[var(--color-rule-soft)]">
              <td className="py-1 pr-3 text-[var(--color-ink-soft)]">
                {money(b.from, currency, locale)} –{" "}
                {b.to === null ? "above" : money(b.to, currency, locale)}
              </td>
              <td className="py-1 text-right text-[var(--color-ink-soft)]">{percent(b.rate)}</td>
              <td className="py-1 pl-3 text-right text-[var(--color-ink-soft)]">
                {money(b.taxableInBand, currency, locale)}
              </td>
              <td className="py-1 pl-3 text-right">{money(b.tax, currency, locale)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className="rule-single py-1 text-right text-[var(--color-ink-soft)]">
              Total across bands
            </td>
            <td className="rule-single py-1 pl-3 text-right font-semibold">
              {money(String(total), currency, locale)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Line({
  step,
  index,
  currency,
  locale,
  isAnswer,
  blank,
}: {
  step: SerialisedStep;
  index: number;
  currency: Currency;
  locale?: string;
  isAnswer: boolean;
  blank: boolean;
}) {
  const [open, setOpen] = useState(false);
  const negative = Number(step.output) < 0;

  return (
    <li className={isAnswer ? "rule-single" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`wp-row cursor-pointer hover:bg-[rgba(22,24,26,0.03)] ${open ? "wp-open" : ""}`}
      >
        <span className="wp-num">{blank ? "" : index + 1}</span>
        <span className={`wp-label ${isAnswer ? "font-semibold" : ""}`}>{step.label}</span>
        <span className="wp-leader" aria-hidden />
        <span
          className={`wp-figure ${isAnswer ? "font-semibold" : ""} ${
            negative ? "text-[var(--color-flag)]" : ""
          }`}
        >
          {blank ? "—" : stepValue(step.output, step.unit, currency, locale)}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--color-rule-soft)] bg-[rgba(22,24,26,0.02)] px-4 py-3 sm:pl-10">
          <p className="f-figure text-xs leading-relaxed break-words text-[var(--color-ink-soft)]">
            {step.formula}
          </p>

          <Bands step={step} currency={currency} locale={locale} />

          {Object.keys(step.inputs).length > 0 && (
            <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              {Object.entries(step.inputs).map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-3 border-b border-dotted border-[var(--color-rule-soft)] py-0.5 text-xs"
                >
                  <dt className="text-[var(--color-ink-soft)]">{k}</dt>
                  <dd className="f-figure">
                    {/* Between 0 and 1 this engine is describing a rate; money
                        amounts below one unit never carry meaning in tax. */}
                    {Math.abs(Number(v)) > 0 && Math.abs(Number(v)) < 1
                      ? percent(v, 3)
                      : money(v, currency, locale)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {step.note && <p className="margin-note mt-3">{step.note}</p>}

          {step.legalRef && <p className="citation mt-3">Authority · {step.legalRef}</p>}
        </div>
      )}
    </li>
  );
}

export function WorkingPaper({
  steps,
  currency,
  locale,
  answer,
  blank = false,
}: {
  steps: SerialisedStep[];
  currency: Currency;
  locale?: string;
  /** The figure that is the answer, so its line can be ruled. */
  answer?: string;
  blank?: boolean;
}) {
  // Only the last line carrying the answer is ruled, and never when it is nil.
  const answerIndex =
    !blank && answer && Number(answer) !== 0
      ? steps.map((s) => s.output).lastIndexOf(answer)
      : -1;

  return (
    <section className="sheet">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-rule)] px-4 py-3">
        <h2 className="eyebrow">How this was calculated</h2>
        <p className="citation">
          {blank ? `${steps.length} lines` : `${steps.length} lines · select one for its basis`}
        </p>
      </header>

      <div className="wp px-4 py-2">
        <ol>
          {steps.map((s, i) => (
            <Line
              key={s.id}
              step={s}
              index={i}
              currency={currency}
              locale={locale}
              isAnswer={i === answerIndex}
              blank={blank}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}
