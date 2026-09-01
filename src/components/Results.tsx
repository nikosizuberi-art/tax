"use client";

import type { CalcResult } from "../engine/types";
import { adapters } from "../adapters";
import { money, percent } from "../lib/format";

/**
 * An assessment notice states the amount first, in a box, and shows the working
 * underneath. This is that box: a double-ruled figure in the money column, then
 * the derived ratios as a footing.
 */
export function ResultBlock({ result, blank }: { result: CalcResult; blank: boolean }) {
  const s = result.summary;
  const c = result.currency;
  const adapter = adapters[result.country];
  const locale = adapter.locale;
  const refund = s.balance.gte(0);

  return (
    <section className="sheet">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-rule)] px-4 py-3">
        <h2 className="eyebrow">Total income tax</h2>
        <p className="citation">
          {result.regionName} · {result.year}
        </p>
      </header>

      <div className="px-4 py-6 sm:px-6">
        <div className="ml-auto w-fit">
          <div className="rule-double" />
          <p
            className={`f-figure py-3 text-right leading-none ${
              blank ? "text-[var(--color-ink-faint)]" : ""
            }`}
            style={{ fontSize: "clamp(1.75rem, 5.5vw, 2.75rem)" }}
          >
            {blank ? "—" : money(s.incomeTax, c, locale)}
          </p>
          <div className="rule-double" />
        </div>

        {blank && (
          <p className="f-statute mt-4 text-right text-sm text-[var(--color-ink-soft)]">
            Enter at least one month of pay to see the computation.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 border-t-[1.5px] border-[var(--color-ink)] sm:grid-cols-4">
        <div className="footing-cell">
          <div className="footing-label">Effective</div>
          <div className="footing-value">{blank ? "—" : percent(s.effectiveIncomeTaxRate)}</div>
          <div className="citation mt-1">
            {blank ? "of gross" : `${percent(s.effectiveRateOnGross)} with contributions`}
          </div>
        </div>
        <div className="footing-cell sm:border-r">
          <div className="footing-label">Marginal</div>
          <div className="footing-value">{blank ? "—" : percent(s.marginalRate)}</div>
          <div className="citation mt-1">on the next 100</div>
        </div>
        <div className="footing-cell">
          <div className="footing-label">Take-home</div>
          <div className="footing-value">{blank ? "—" : money(s.takeHome, c, locale)}</div>
          <div className="citation mt-1">
            {blank ? "after tax" : `${money(s.monthlyTakeHome, c, locale)} a month`}
          </div>
        </div>
        <div className="footing-cell border-r-0">
          <div className="footing-label">
            {adapter.hasWithholding === false
              ? "Withheld at source"
              : refund
                ? "Refund due"
                : "Owing"}
          </div>
          <div
            className={`footing-value ${
              !blank && !s.withheld.isZero() && !refund ? "text-[var(--color-flag)]" : ""
            }`}
          >
            {blank || s.withheld.isZero() ? "—" : money(s.balance.abs(), c, locale)}
          </div>
          <div className="citation mt-1">
            {adapter.hasWithholding === false
              ? "nothing is withheld from pay here"
              : s.withheld.isZero()
                ? "enter tax withheld"
                : `${money(s.withheld, c, locale)} withheld`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2">
        <div className="footing-cell border-b-0">
          <div className="footing-label">Gross assessed</div>
          <div className="footing-value">{blank ? "—" : money(s.annualGross, c, locale)}</div>
          <div className="citation mt-1">{s.monthsWorked} of 12 months carry income</div>
        </div>
        <div className="footing-cell border-r-0 border-b-0">
          <div className="footing-label">{adapter.contributionLabel}</div>
          <div className="footing-value">
            {blank ? "—" : money(s.socialContributions, c, locale)}
          </div>
          <div className="citation mt-1">{adapter.contributionNote ?? "employee share"}</div>
        </div>
      </div>
    </section>
  );
}

/** The reviewer's marks: what the computation cannot tell you on its own. */
export function ReviewerNotes({ result }: { result: CalcResult }) {
  if (result.warnings.length === 0) return null;
  return (
    <section className="sheet px-4 py-4">
      <h2 className="eyebrow mb-3">Marked for your attention</h2>
      <ul className="space-y-3">
        {result.warnings.map((w, i) => (
          <li key={i} className="margin-note">
            {w}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Provenance({ result }: { result: CalcResult }) {
  const unverified = result.rulesets.filter((r) => r.provenance.confidence !== "verified");

  return (
    <section className="sheet">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-rule)] px-4 py-3">
        <h2 className="eyebrow">Notes to the computation</h2>
        <p className="citation">
          {result.rulesets.length} ruleset{result.rulesets.length === 1 ? "" : "s"}
        </p>
      </header>

      {unverified.length > 0 && (
        <div className="flex items-start gap-4 border-b border-[var(--color-rule)] px-4 py-4">
          <span className="stamp stamp-unverified mt-0.5 shrink-0">Unverified</span>
          <p className="f-statute text-sm leading-relaxed">
            {unverified.length === result.rulesets.length
              ? "These figures"
              : "Some of these figures"}{" "}
            were read from the sources named below on the dates shown, but have not been reconciled
            line by line against the legislation or the tax authority&rsquo;s own tables. Check the
            figures that matter to you.
          </p>
        </div>
      )}

      <div className="divide-y divide-[var(--color-rule-soft)]">
        {result.rulesets.map((r) => (
          <div key={r.id} className="px-4 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="f-figure text-xs font-semibold">{r.version}</span>
              <span className="citation">
                {r.provenance.verifiedOn ? `read ${r.provenance.verifiedOn}` : "not yet checked"}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-soft)]">
              {r.provenance.source}
            </p>
            <p className="f-statute mt-2 text-xs leading-relaxed text-[var(--color-ink-soft)]">
              {r.provenance.notes}
            </p>
            <a
              href={r.provenance.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="citation mt-2 inline-block underline decoration-dotted underline-offset-4 hover:text-[var(--color-ink)]"
            >
              Open the source
            </a>

            {r.verificationTodo && r.verificationTodo.length > 0 && (
              <details className="mt-3">
                <summary className="eyebrow cursor-pointer">
                  Still to verify ({r.verificationTodo.length})
                </summary>
                <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                  {r.verificationTodo.map((t, i) => (
                    <li key={i} className="border-l border-[var(--color-rule)] pl-3">
                      {t}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {r.omissions && r.omissions.length > 0 && (
              <details className="mt-2">
                <summary className="eyebrow cursor-pointer">
                  Not modelled ({r.omissions.length})
                </summary>
                <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                  {r.omissions.map((t, i) => (
                    <li key={i} className="border-l border-[var(--color-rule)] pl-3">
                      {t}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function LegalNotice() {
  return (
    <section className="border-[1.5px] border-[var(--color-ink)] px-4 py-4">
      <h2 className="eyebrow mb-2">Notice</h2>
      <p className="text-sm leading-relaxed">
        Estimate for informational purposes only. This is not tax advice. Figures are based on
        published rates for the selected year and do not account for all personal circumstances.
        Consult a qualified tax professional or the relevant tax authority before acting on this.
      </p>
    </section>
  );
}
