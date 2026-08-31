"use client";

import type { CalcResult } from "../engine/types";
import { adapters } from "../adapters";
import { money, percent } from "../lib/format";

function Metric({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "bad";
}) {
  const tones = {
    default: "text-slate-900",
    good: "text-emerald-700",
    bad: "text-rose-700",
  } as const;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Results({ result }: { result: CalcResult }) {
  const s = result.summary;
  const c = result.currency;
  const refund = s.balance.gte(0);
  const adapter = adapters[result.country];
  const socialLabel = adapter.contributionLabel;
  const locale = adapter.locale;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Metric
          label="Total income tax"
          value={money(s.incomeTax, c, locale)}
          sub={`${result.regionName} · tax year ${result.year}`}
        />
        <Metric
          label="Effective rate"
          value={percent(s.effectiveIncomeTaxRate)}
          sub={`${percent(s.effectiveRateOnGross)} including ${socialLabel.toLowerCase()}`}
        />
        <Metric
          label="Marginal rate"
          value={percent(s.marginalRate)}
          sub="on your next 100 of gross pay"
        />
        <Metric
          label="Take-home"
          value={money(s.takeHome, c, locale)}
          sub={`${money(s.monthlyTakeHome, c, locale)} a month`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Metric
          label="Gross income assessed"
          value={money(s.annualGross, c, locale)}
          sub={`${s.monthsWorked} month(s) with income`}
        />
        <Metric
          label={socialLabel}
          value={money(s.socialContributions, c, locale)}
          sub={adapter.contributionNote}
        />
        {s.withheld.isZero() ? (
          <Metric
            label="Refund or amount owing"
            value="—"
            sub="Enter the tax withheld on each payslip to compare it against the liability. This is the number most people actually want."
          />
        ) : (
          <Metric
            label={refund ? "Refund due" : "Amount owing"}
            value={money(s.balance.abs(), c, locale)}
            tone={refund ? "good" : "bad"}
            sub={`${money(s.withheld, c, locale)} withheld against ${money(s.incomeTax, c, locale)} due`}
          />
        )}
      </div>

      {result.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-900">Worth knowing about your figures</h3>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-amber-900">
            {result.warnings.map((w, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Provenance({ result }: { result: CalcResult }) {
  const unverified = result.rulesets.filter((r) => r.provenance.confidence !== "verified");

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Rulesets used</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Every result is stamped with the ruleset versions that produced it, so an old calculation
        stays reproducible.
      </p>

      {unverified.length > 0 && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-xs font-semibold text-rose-900">
            {unverified.length === result.rulesets.length
              ? "None of the rulesets behind this figure have been verified against their official source."
              : "Some rulesets behind this figure have not been verified against their official source."}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-rose-800">
            Rates and thresholds were read from published sources on the date shown below, but they
            have not been reconciled line by line against the legislation or the tax authority&rsquo;s own
            tables. Treat the result as indicative, and check the figures that matter to you.
          </p>
        </div>
      )}

      <div className="mt-3 space-y-3">
        {result.rulesets.map((r) => (
          <div key={r.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-slate-800">{r.version}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  r.provenance.confidence === "verified"
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-amber-100 text-amber-800"
                }`}
              >
                {r.provenance.confidence.replace("-", " ")}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-slate-600">{r.provenance.source}</p>
            <p className="mt-1 text-xs text-slate-500">
              Verified on: {r.provenance.verifiedOn ?? "not yet verified"} ·{" "}
              <a
                href={r.provenance.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-700 underline underline-offset-2"
              >
                official source
              </a>
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{r.provenance.notes}</p>

            {r.verificationTodo && r.verificationTodo.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-slate-600">
                  Figures still to verify ({r.verificationTodo.length})
                </summary>
                <ul className="mt-1.5 space-y-1 pl-4 text-xs text-slate-500">
                  {r.verificationTodo.map((t, i) => (
                    <li key={i} className="list-disc">
                      {t}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {r.omissions && r.omissions.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-xs font-medium text-slate-600">
                  Not modelled in this version ({r.omissions.length})
                </summary>
                <ul className="mt-1.5 space-y-1 pl-4 text-xs text-slate-500">
                  {r.omissions.map((t, i) => (
                    <li key={i} className="list-disc">
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
    <section className="rounded-xl border-2 border-slate-300 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Before you rely on this</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
        Estimate for informational purposes only. This is not tax advice. Figures are based on
        published rates for the selected year and do not account for all personal circumstances.
        Consult a qualified tax professional or the relevant tax authority before acting on this.
      </p>
    </section>
  );
}
