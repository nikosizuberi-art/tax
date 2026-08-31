"use client";

import { useEffect, useMemo, useState } from "react";
import { COUNTRIES, getAdapter } from "../adapters";
import { currencySpec } from "../engine/currency";
import type { CountryCode, FieldSpec, FieldValue } from "../engine/types";
import { emptyMonths } from "../engine/inputs";
import { Field } from "../components/Fields";
import { Results, Provenance, LegalNotice } from "../components/Results";
import { Trace } from "../components/Trace";

const GROUP_TITLES: Record<FieldSpec["group"], { title: string; blurb: string }> = {
  income: {
    title: "Income and withholding",
    blurb:
      "Enter what you were actually paid, month by month. Tax is assessed annually; the monthly entry exists so the app can compare your liability against what was withheld.",
  },
  deductions: {
    title: "Deductible items",
    blurb:
      "Only these categories reduce tax, and they differ by country. Ordinary personal spending — groceries, travel, subscriptions, rent outside a specific relief — is not deductible anywhere here, so there is no spending diary.",
  },
  personal: {
    title: "Personal and family circumstances",
    blurb: "These drive the allowances that are set by who you are rather than what you earn.",
  },
  regional: {
    title: "Regional reliefs",
    blurb:
      "Set by your region alone. Each carries strict conditions — confirm you meet them before ticking eligibility.",
  },
};

function defaultsFor(fields: FieldSpec[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f.kind === "monthly-money") out[f.id] = emptyMonths();
    else if (f.default !== undefined) out[f.id] = f.default as FieldValue;
  }
  return out;
}

export default function Page() {
  const [country, setCountry] = useState<CountryCode>("ES");
  const [year, setYear] = useState<number>(2026);
  const [regionCode, setRegionCode] = useState<string>("madrid");
  const [valuesByCountry, setValuesByCountry] = useState<
    Partial<Record<CountryCode, Record<string, FieldValue>>>
  >({});
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const adapter = getAdapter(country);
  const years = adapter.years();
  const regions = adapter.regions(year);

  // Keep the region valid whenever the country changes.
  useEffect(() => {
    const list = getAdapter(country).regions(year);
    if (!list.some((r) => r.code === regionCode)) setRegionCode(list[0]?.code ?? "");
  }, [country, year, regionCode]);

  const fields = useMemo(
    () => (regions.some((r) => r.code === regionCode) ? adapter.fields(year, regionCode) : []),
    [adapter, year, regionCode, regions],
  );

  const values = useMemo(() => {
    const stored = valuesByCountry[country] ?? {};
    return { ...defaultsFor(fields), ...stored };
  }, [valuesByCountry, country, fields]);

  const symbol = currencySpec(adapter.currency).symbol;
  const singleRegion = regions.length <= 1;

  function setValue(id: string, v: FieldValue) {
    setValuesByCountry((prev) => ({ ...prev, [country]: { ...(prev[country] ?? {}), [id]: v } }));
  }

  const result = useMemo(() => {
    if (!regions.some((r) => r.code === regionCode)) return null;
    try {
      return adapter.compute({ country, year, regionCode, values });
    } catch {
      return null;
    }
  }, [adapter, country, year, regionCode, values, regions]);

  const grouped = (["income", "deductions", "personal", "regional"] as const)
    .map((g) => ({ group: g, items: fields.filter((f) => f.group === g) }))
    .filter((g) => g.items.length > 0);

  const hasIncome = result ? result.summary.annualGross.gt(0) : false;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Personal income tax estimator
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
          Twelve countries, each computed through its own pipeline, because they build the tax in
          genuinely different ways: Spain applies its scales twice and subtracts the second result,
          Canada subtracts credits valued at the lowest rate, Hong Kong computes the tax twice and
          charges the lower figure, Germany evaluates a polynomial rather than brackets, and Kuwait
          does not tax income at all. Every figure comes with a step-by-step trace.
        </p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
          <span aria-hidden>🔒</span>
          Everything runs in your browser. No income figure is ever sent to a server, and nothing is
          stored.
        </p>
      </header>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-500">Country</span>
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              value={country}
              onChange={(e) => setCountry(e.target.value as CountryCode)}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-500">Tax year</span>
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-500">
              {adapter.regionLabel}
              {singleRegion ? "" : " (required)"}
            </span>
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500"
              value={regionCode}
              disabled={singleRegion}
              onChange={(e) => setRegionCode(e.target.value)}
            >
              {regions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{adapter.regionNote}</p>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-7">
          {grouped.map(({ group, items }) => (
            <section key={group}>
              <h2 className="text-sm font-semibold text-slate-900">{GROUP_TITLES[group].title}</h2>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-500">
                {GROUP_TITLES[group].blurb}
              </p>
              <div className="space-y-3">
                {items.map((f) => (
                  <Field
                    key={f.id}
                    field={f}
                    value={values[f.id] ?? null}
                    onChange={(v) => setValue(f.id, v)}
                    symbol={symbol}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="space-y-6 xl:col-span-5">
          {!mounted || !result ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
              Preparing the calculator…
            </div>
          ) : (
            <>
              <Results result={result} />
              <LegalNotice />
              <Provenance result={result} />
            </>
          )}
        </div>
      </div>

      {mounted && result && (
        <div className="mt-6">
          {hasIncome ? (
            <Trace steps={result.steps} currency={result.currency} locale={adapter.locale} />
          ) : (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              Enter at least one month of income to see the full calculation trace.
            </p>
          )}
        </div>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
        <p>
          Out of scope everywhere in this version: self-employment and business income, capital gains,
          non-residents, joint filing and mid-year changes of residence. Each country also has its own
          list of things it does not model, shown with the result above.
        </p>
        {mounted && result && (
          <p className="mt-2">
            Computed {new Date(result.computedAt).toLocaleString()} using{" "}
            {result.rulesets.map((r) => r.version).join(" + ")}.
          </p>
        )}
      </footer>
    </main>
  );
}
