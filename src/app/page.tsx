"use client";

import { useEffect, useMemo, useState } from "react";
import { COUNTRIES, getAdapter } from "../adapters";
import { currencySpec } from "../engine/currency";
import type { CountryCode, FieldSpec, FieldValue } from "../engine/types";
import { emptyMonths } from "../engine/inputs";
import { Field } from "../components/Fields";
import { ResultBlock, ReviewerNotes, Provenance, LegalNotice } from "../components/Results";
import { WorkingPaper } from "../components/WorkingPaper";

/** The groups are the schedules of a return, so they are lettered like one. */
const SECTIONS: Record<FieldSpec["group"], { letter: string; title: string; blurb: string }> = {
  income: {
    letter: "A",
    title: "Income and withholding",
    blurb:
      "What you were actually paid, month by month. Tax is assessed annually; the months matter because contribution ceilings are not.",
  },
  deductions: {
    letter: "B",
    title: "Deductible items",
    blurb:
      "Only these categories reduce tax, and they differ by country. Ordinary spending is not deductible anywhere here.",
  },
  personal: {
    letter: "C",
    title: "Personal circumstances",
    blurb: "Allowances set by who you are rather than by what you earn.",
  },
  regional: {
    letter: "D",
    title: "Regional reliefs",
    blurb: "Set by your region alone, and each carries strict conditions.",
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

  const blank = !result || result.summary.annualGross.lte(0);
  const reference = `${country}-${year}-${regionCode}`.toUpperCase();

  return (
    <main className="mx-auto max-w-[86rem] px-5 py-8 sm:px-8 lg:py-12">
      {/* ---------------------------------------------------------- masthead */}
      <header className="border-b-[1.5px] border-[var(--color-ink)] pb-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-2xl">
            <p className="eyebrow">Working paper · estimate only</p>
            <h1
              className="mt-2 leading-[0.95] font-semibold tracking-[-0.025em]"
              style={{ fontSize: "clamp(2rem, 6vw, 3.25rem)" }}
            >
              Estimate of liability
            </h1>
            <p className="f-statute mt-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-soft)]">
              Twelve jurisdictions, each computed through its own pipeline — because a bracket table
              is not how any of them actually works. Every figure is shown with the line that
              produced it and the authority behind it.
            </p>
          </div>

          <div className="min-w-[13rem] border border-[var(--color-rule)] px-3 py-2.5">
            <dl className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="citation">Ref</dt>
                <dd className="f-figure text-xs">{reference}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="citation">Basis</dt>
                <dd className="f-figure text-xs">
                  {mounted && result ? result.rulesets[0].version : "—"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="citation">Drawn</dt>
                <dd className="f-figure text-xs">
                  {mounted && result ? result.computedAt.slice(0, 10) : "—"}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Jurisdiction is chosen here, because nothing below means anything without it. */}
        <div className="mt-7 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-3">
          <label className="block">
            <span className="eyebrow">Country</span>
            <select
              className="picker mt-1"
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
            <span className="eyebrow">Tax year</span>
            <select
              className="picker mt-1"
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
            <span className="eyebrow">{adapter.regionLabel}</span>
            <select
              className="picker mt-1"
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

        <p className="f-statute mt-4 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-soft)]">
          {adapter.regionNote}
        </p>
      </header>

      {/* -------------------------------------------------------------- body */}
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-5">
          <div className="sheet px-5 py-6 sm:px-6">
            {grouped.map(({ group, items }) => (
              <section key={group} className="mb-9 last:mb-0">
                <div className="band">
                  <span className="band-letter">{SECTIONS[group].letter}</span>
                  <h2 className="band-title">{SECTIONS[group].title}</h2>
                </div>
                <p className="f-statute mb-5 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                  {SECTIONS[group].blurb}
                </p>
                {items.map((f) => (
                  <Field
                    key={f.id}
                    field={f}
                    value={values[f.id] ?? null}
                    onChange={(v) => setValue(f.id, v)}
                    symbol={symbol}
                  />
                ))}
              </section>
            ))}
          </div>

          <p className="citation mt-4 leading-relaxed">
            Computed in your browser. No figure you enter is sent anywhere, and nothing is stored.
          </p>
        </div>

        <div className="lg:col-span-7">
          {!mounted || !result ? (
            <div className="sheet px-5 py-16 text-center">
              <p className="citation">Preparing the sheet…</p>
            </div>
          ) : (
            <div key={blank ? "blank" : "live"} className="settle space-y-6">
              <ResultBlock result={result} blank={blank} />
              <WorkingPaper
                steps={result.steps}
                currency={result.currency}
                locale={adapter.locale}
                answer={result.summary.incomeTax.toString()}
                blank={blank}
              />
              <ReviewerNotes result={result} />
              <LegalNotice />
              <Provenance result={result} />
            </div>
          )}
        </div>
      </div>

      <footer className="mt-14 border-t border-[var(--color-rule)] pt-5">
        <p className="citation max-w-3xl leading-relaxed">
          Out of scope everywhere: self-employment and business income, capital gains,
          non-residents, joint filing, and mid-year changes of residence. Each jurisdiction lists
          its own omissions in the notes above.
        </p>
      </footer>
    </main>
  );
}
