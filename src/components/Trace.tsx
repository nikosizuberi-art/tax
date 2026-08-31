"use client";

import { useState } from "react";
import type { SerialisedStep } from "../engine/trace";
import type { Currency } from "../engine/money";
import { money, percent, stepValue } from "../lib/format";

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
      <table className="w-full min-w-[26rem] text-xs tabular">
        <thead>
          <tr className="text-slate-500">
            <th className="py-1 text-left font-medium">Band</th>
            <th className="py-1 text-right font-medium">Rate</th>
            <th className="py-1 text-right font-medium">Amount in band</th>
            <th className="py-1 text-right font-medium">Tax</th>
          </tr>
        </thead>
        <tbody>
          {step.bands.map((b, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="py-1 text-slate-600">
                {money(b.from, currency, locale)} –{" "}
                {b.to === null ? "above" : money(b.to, currency, locale)}
              </td>
              <td className="py-1 text-right text-slate-600">{percent(b.rate)}</td>
              <td className="py-1 text-right text-slate-600">{money(b.taxableInBand, currency, locale)}</td>
              <td className="py-1 text-right font-medium text-slate-800">{money(b.tax, currency, locale)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300">
            <td colSpan={3} className="py-1 text-right text-slate-500">
              Total across bands
            </td>
            <td className="py-1 text-right font-semibold text-slate-900">
              {money(String(total), currency, locale)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Step({
  step,
  index,
  currency,
  locale,
}: {
  step: SerialisedStep;
  index: number;
  currency: Currency;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  const negative = Number(step.output) < 0;

  return (
    <li className="border-t border-slate-200 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-900">{step.label}</span>
          <span className="mt-0.5 block break-words font-mono text-xs leading-relaxed text-slate-500">
            {step.formula}
          </span>
        </span>
        <span
          className={`shrink-0 text-sm font-semibold tabular ${negative ? "text-rose-600" : "text-slate-900"}`}
        >
          {stepValue(step.output, step.unit, currency, locale)}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 pl-13">
          <Bands step={step} currency={currency} locale={locale} />

          {Object.keys(step.inputs).length > 0 && (
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(step.inputs).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 text-xs">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="tabular font-medium text-slate-700">
                    {/* A value between 0 and 1 is a rate in this engine; money amounts
                        below one unit never carry meaning in a tax computation. */}
                    {Math.abs(Number(v)) > 0 && Math.abs(Number(v)) < 1
                      ? percent(v, 3)
                      : money(v, currency, locale)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {step.note && <p className="mt-3 text-xs leading-relaxed text-slate-600">{step.note}</p>}

          {step.legalRef && (
            <p className="mt-2 text-xs font-medium text-slate-500">Legal basis: {step.legalRef}</p>
          )}
        </div>
      )}
    </li>
  );
}

export function Trace({
  steps,
  currency,
  locale,
}: {
  steps: SerialisedStep[];
  currency: Currency;
  locale?: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
      <header className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Calculation trace</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Every line is generated from the object that produced the number, so the explanation and
          the figure cannot disagree. Select a line to see its inputs, bands and legal basis.
        </p>
      </header>
      <ol>
        {steps.map((s, i) => (
          <Step key={s.id} step={s} index={i} currency={currency} locale={locale} />
        ))}
      </ol>
    </section>
  );
}
