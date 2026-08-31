import { Decimal, ZERO, round, formatPlain, type Rounding, type Currency } from "./money";
import { serialiseTrace, type Trace } from "./trace";
import type { CalcInput, CalcResult, CountryCode, RulesetStamp } from "./types";

/**
 * What every country pipeline hands back. The pipeline itself - the order of
 * the steps and what each one means - lives in the country adapter and is
 * never shared. This is only the plumbing around it.
 */
export interface CoreResult {
  trace: Trace;
  /** Total income brought into charge, in the country's own sense of that. */
  grossAssessed: Decimal;
  /** Compulsory employee contributions that are not income tax. */
  social: Decimal;
  incomeTax: Decimal;
  withheld: Decimal;
  months: number;
  warnings: string[];
}

export type CoreFn = (input: CalcInput, probe: Decimal) => CoreResult;

export const DEFAULT_PROBE = new Decimal(100);

/**
 * The marginal rate is measured, not read off a rate table: the whole pipeline
 * runs again with a little more gross pay and the difference is divided by the
 * increment. That is the only way to capture Spain's tapering work-income
 * reduction, Canada's and the UK's allowance phase-outs, India's marginal
 * relief and Australia's Medicare shade-in without hand-coding each one.
 */
export function runPipeline(opts: {
  input: CalcInput;
  core: CoreFn;
  country: CountryCode;
  currency: Currency;
  locale?: string;
  regionCode: string;
  regionName: string;
  rulesets: RulesetStamp[];
  rounding: Rounding;
  probe?: Decimal;
  /** Extra note for the marginal-rate trace step, e.g. naming a local quirk. */
  marginalNote?: string;
}): CalcResult {
  const probe = opts.probe ?? DEFAULT_PROBE;
  const base = opts.core(opts.input, ZERO);
  const bumped = opts.core(opts.input, probe);
  // Reported marginal rate is income tax only, consistent across every country.
  // The combined figure including compulsory contributions is exposed in the
  // trace step, because that is the number a payslip actually moves by.
  const marginal = bumped.incomeTax.minus(base.incomeTax).dividedBy(probe);
  const marginalWithContributions = bumped.incomeTax
    .plus(bumped.social)
    .minus(base.incomeTax.plus(base.social))
    .dividedBy(probe);

  const f = (v: Decimal) => formatPlain(v, opts.currency, opts.locale);

  base.trace.add({
    id: "marginal",
    label: "Effective marginal rate",
    formula: `(income tax on ${f(base.grossAssessed.plus(probe))} - income tax on ${f(base.grossAssessed)}) / ${f(probe)}`,
    inputs: {
      "income tax now": base.incomeTax,
      "income tax with more pay": bumped.incomeTax,
      "contributions now": base.social,
      "contributions with more pay": bumped.social,
      "including compulsory contributions": marginalWithContributions,
    },
    output: marginal,
    note:
      (opts.marginalNote ? `${opts.marginalNote} ` : "") +
      "Measured by adding a little more gross pay and re-running the whole pipeline, so tapers, phase-outs, surcharges and contribution ceilings are all reflected rather than just the bracket rates.",
    unit: "percent",
  });

  const takeHome = base.grossAssessed.minus(base.social).minus(base.incomeTax);
  const denom = base.grossAssessed.isZero() ? new Decimal(1) : base.grossAssessed;

  return {
    country: opts.country,
    year: opts.input.year,
    regionCode: opts.regionCode,
    regionName: opts.regionName,
    currency: opts.currency,
    summary: {
      annualGross: base.grossAssessed,
      socialContributions: base.social,
      incomeTax: base.incomeTax,
      totalDeductions: base.social.plus(base.incomeTax),
      takeHome,
      monthlyTakeHome: round(takeHome.dividedBy(12), opts.rounding),
      effectiveRateOnGross: base.social.plus(base.incomeTax).dividedBy(denom),
      effectiveIncomeTaxRate: base.incomeTax.dividedBy(denom),
      marginalRate: marginal,
      withheld: base.withheld,
      balance: round(base.withheld.minus(base.incomeTax), opts.rounding),
      monthsWorked: base.months,
    },
    steps: serialiseTrace(base.trace),
    rulesets: opts.rulesets,
    warnings: base.warnings,
    computedAt: new Date().toISOString(),
  };
}
