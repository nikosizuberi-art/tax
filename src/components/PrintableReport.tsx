"use client";

import { Fragment } from "react";
import type { CalcResult, FieldSpec, FieldValue } from "../engine/types";
import { adapters } from "../adapters";
import { MONTHS } from "../engine/inputs";
import { money, percent, stepValue } from "../lib/format";

/**
 * The printed document.
 *
 * This is not the screen layout squeezed onto paper. A printed working paper
 * has a different job: it has to stand alone. So every trace line is expanded
 * rather than collapsed behind a click, the figures the user typed are restated
 * as a schedule, and the authority and the caveats travel with the number.
 *
 * It renders only for print, and the interactive app is hidden in its place.
 */
export function PrintableReport({
  result,
  fields,
  values,
}: {
  result: CalcResult;
  fields: FieldSpec[];
  values: Record<string, FieldValue>;
}) {
  const s = result.summary;
  const c = result.currency;
  const adapter = adapters[result.country];
  const locale = adapter.locale;
  const refund = s.balance.gte(0);
  const reference = `${result.country}-${result.year}-${result.regionCode}`.toUpperCase();

  const monthlyFields = fields.filter((f) => f.kind === "monthly-money");
  const otherFields = fields.filter((f) => f.kind !== "monthly-money");

  const entered = (id: string) => {
    const v = values[id];
    return Array.isArray(v) ? v : null;
  };
  const hasAny = (id: string) => (entered(id) ?? []).some((m) => m !== null && m !== "");

  // An optional field left at its default was not "entered", so it does not
  // belong in a schedule of what was entered. A required one is kept even at
  // its default, because it still drove the computation.
  const scalarValue = (f: FieldSpec): string | null => {
    const v = values[f.id];
    if (v === null || v === undefined || v === "" || Array.isArray(v)) return null;
    if (typeof v === "boolean") return v ? "Yes" : null;
    if (f.optional && f.default !== undefined && String(v) === String(f.default)) return null;
    if (f.kind === "enum") {
      return f.options?.find((o) => o.value === String(v))?.label ?? String(v);
    }
    if (String(v) === "0") return null;
    return String(v);
  };
  const scalars = otherFields
    .map((f) => ({ f, value: scalarValue(f) }))
    .filter((x) => x.value !== null);

  return (
    <div className="print-doc">
      {/* ---------------------------------------------------------- masthead */}
      <header className="pr-masthead">
        <div className="pr-masthead-main">
          <p className="eyebrow">Working paper · estimate only</p>
          <h1 className="pr-title">Estimate of liability</h1>
          <p className="citation pr-sub">
            {adapter.label} · {result.regionName} · tax year {result.year}
          </p>
        </div>
        <dl className="pr-ref">
          <div>
            <dt className="citation">Ref</dt>
            <dd className="f-figure">{reference}</dd>
          </div>
          <div>
            <dt className="citation">Basis</dt>
            <dd className="f-figure">{result.rulesets.map((r) => r.version).join(" + ")}</dd>
          </div>
          <div>
            <dt className="citation">Drawn</dt>
            <dd className="f-figure">{result.computedAt.slice(0, 10)}</dd>
          </div>
        </dl>
      </header>

      {/* ----------------------------------------------------------- summary */}
      <section className="pr-section">
        <h2 className="pr-h2">Summary</h2>
        <div className="pr-total">
          <div className="rule-double" />
          <div className="pr-total-row">
            <span className="pr-total-label">Total income tax</span>
            <span className="f-figure pr-total-figure">{money(s.incomeTax, c, locale)}</span>
          </div>
          <div className="rule-double" />
        </div>

        <table className="pr-table">
          <tbody>
            <tr>
              <td>Gross income assessed</td>
              <td className="f-figure pr-num">{money(s.annualGross, c, locale)}</td>
              <td>{adapter.contributionLabel}</td>
              <td className="f-figure pr-num">{money(s.socialContributions, c, locale)}</td>
            </tr>
            <tr>
              <td>Effective rate</td>
              <td className="f-figure pr-num">{percent(s.effectiveIncomeTaxRate)}</td>
              <td>Including contributions</td>
              <td className="f-figure pr-num">{percent(s.effectiveRateOnGross)}</td>
            </tr>
            <tr>
              <td>Marginal rate on the next 100</td>
              <td className="f-figure pr-num">{percent(s.marginalRate)}</td>
              <td>Take-home</td>
              <td className="f-figure pr-num">{money(s.takeHome, c, locale)}</td>
            </tr>
            <tr>
              <td>Months carrying income</td>
              <td className="f-figure pr-num">{s.monthsWorked} of 12</td>
              <td>
                {adapter.hasWithholding === false
                  ? "Withheld at source"
                  : refund
                    ? "Refund due"
                    : "Amount owing"}
              </td>
              <td className="f-figure pr-num">
                {adapter.hasWithholding === false || s.withheld.isZero()
                  ? "—"
                  : money(s.balance.abs(), c, locale)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------- what was entered */}
      <section className="pr-section">
        <h2 className="pr-h2">Schedule of what was entered</h2>
        {monthlyFields.filter((f) => hasAny(f.id)).length === 0 && scalars.length === 0 && (
          <p className="citation">Nothing was entered.</p>
        )}

        {monthlyFields
          .filter((f) => hasAny(f.id))
          .map((f) => (
            <div key={f.id} className="pr-schedule">
              <p className="pr-schedule-title">{f.label}</p>
              <table className="pr-table pr-months">
                <tbody>
                  {[0, 1, 2].map((row) => (
                    <tr key={row}>
                      {[0, 1, 2, 3].map((col) => {
                        const i = row * 4 + col;
                        const raw = (entered(f.id) ?? [])[i];
                        return (
                          <Fragment key={i}>
                            <td className="citation">{MONTHS[i].slice(0, 3)}</td>
                            <td className="f-figure pr-num">
                              {raw === null || raw === undefined || raw === ""
                                ? "—"
                                : money(String(raw), c, locale)}
                            </td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {scalars.length > 0 && (
          <table className="pr-table">
            <tbody>
              {scalars.map(({ f, value }) => (
                <tr key={f.id}>
                  <td colSpan={3}>{f.label}</td>
                  <td className="f-figure pr-num">
                    {f.kind === "annual-money" ? money(String(value), c, locale) : value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* -------------------------------------------------- the computation */}
      <section className="pr-section">
        <h2 className="pr-h2">How this was calculated</h2>
        <ol className="pr-steps">
          {result.steps.map((step, i) => (
            <li key={step.id} className="pr-step">
              <div className="pr-step-head">
                <span className="pr-step-num f-figure">{i + 1}</span>
                <span className="pr-step-label">{step.label}</span>
                <span className="pr-step-leader" aria-hidden />
                <span className="f-figure pr-step-figure">
                  {stepValue(step.output, step.unit, c, locale)}
                </span>
              </div>
              <p className="f-figure pr-formula">{step.formula}</p>

              {step.bands && step.bands.length > 0 && (
                <table className="pr-table pr-bands">
                  <thead>
                    <tr className="citation">
                      <th>Band</th>
                      <th className="pr-num">Rate</th>
                      <th className="pr-num">In band</th>
                      <th className="pr-num">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step.bands.map((b, bi) => (
                      <tr key={bi}>
                        <td className="f-figure">
                          {money(b.from, c, locale)} –{" "}
                          {b.to === null ? "above" : money(b.to, c, locale)}
                        </td>
                        <td className="f-figure pr-num">{percent(b.rate)}</td>
                        <td className="f-figure pr-num">{money(b.taxableInBand, c, locale)}</td>
                        <td className="f-figure pr-num">{money(b.tax, c, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {step.note && <p className="pr-note">{step.note}</p>}
              {step.legalRef && <p className="citation pr-auth">Authority · {step.legalRef}</p>}
            </li>
          ))}
        </ol>
      </section>

      {/* ------------------------------------------------------------ notes */}
      {result.warnings.length > 0 && (
        <section className="pr-section">
          <h2 className="pr-h2">Marked for your attention</h2>
          <ul className="pr-warnings">
            {result.warnings.map((w, i) => (
              <li key={i} className="margin-note">
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pr-section pr-notice">
        <h2 className="pr-h2">Notice</h2>
        <p>
          Estimate for informational purposes only. This is not tax advice. Figures are based on
          published rates for the selected year and do not account for all personal circumstances.
          Consult a qualified tax professional or the relevant tax authority before acting on this.
        </p>
      </section>

      <section className="pr-section">
        <h2 className="pr-h2">Notes to the computation</h2>
        {result.rulesets.map((r) => (
          <div key={r.id} className="pr-ruleset">
            <p>
              <span className="f-figure pr-version">{r.version}</span>{" "}
              <span className="citation">
                {r.provenance.confidence === "verified"
                  ? `verified ${r.provenance.verifiedOn}`
                  : r.provenance.verifiedOn
                    ? `read ${r.provenance.verifiedOn} · not reconciled against the legislation`
                    : "not yet checked"}
              </span>
            </p>
            <p className="pr-source">{r.provenance.source}</p>
            <p className="pr-note">{r.provenance.notes}</p>
            {r.verificationTodo && r.verificationTodo.length > 0 && (
              <>
                <p className="citation pr-list-head">Still to verify</p>
                <ul className="pr-list">
                  {r.verificationTodo.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
            {r.omissions && r.omissions.length > 0 && (
              <>
                <p className="citation pr-list-head">Not modelled</p>
                <ul className="pr-list">
                  {r.omissions.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}
      </section>

      <footer className="pr-footer citation">
        Computed in the browser from ruleset {result.rulesets.map((r) => r.version).join(" + ")}. No
        figure was sent to a server. Reference {reference}, drawn {result.computedAt.slice(0, 10)}.
      </footer>
    </div>
  );
}
