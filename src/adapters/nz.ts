import {
  Decimal,
  d,
  ZERO,
  min,
  sum,
  floorZero,
  round,
  formatPlain,
  type Rounding,
} from "../engine/money";
import { evaluateScale, type ScaleSpec } from "../engine/brackets";
import { Trace } from "../engine/trace";
import {
  loadGeneric,
  genericRegion,
  genericRegions,
  genericYears,
  registerGeneric,
  stamp,
  type GenericRuleset,
  type GenericRegion,
} from "../engine/registry";
import { readMonthly, readBool, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import nz2026 from "../../rules/nz/2026/national.json";

registerGeneric("NZ", 2026, nz2026);

interface NzRules extends GenericRuleset {
  brackets: ScaleSpec;
  accLevy: { legalRef: string; rate: string; maximumLiableEarnings: string; note: string };
  ietc: {
    legalRef: string;
    amount: string;
    lowerThreshold: string;
    fullCreditCeiling: string;
    abatementRate: string;
    upperThreshold: string;
    note: string;
  };
}

const f = (v: Decimal) => formatPlain(v, "NZD");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * New Zealand's pipeline is the shortest here, and that is the point: no
 * tax-free threshold, no personal allowance, no deductions for an employee.
 * The two things that are not simply brackets are the ACC levy, which stops at
 * a ceiling, and the independent earner tax credit, which exists only in a
 * window between two incomes and is withdrawn inside it.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<NzRules>("NZ", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "nz-1",
    label: "Gross earnings for the year",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* ACC earners' levy ---------------------------------------------------------- */
  const acc = rules.accLevy;
  const liable = min(gross, d(acc.maximumLiableEarnings));
  const levy = trace.add({
    id: "nz-2",
    label: "ACC earners' levy",
    formula: `${pct(d(acc.rate))} x min(${f(gross)}, ${f(d(acc.maximumLiableEarnings))})`,
    inputs: { "liable earnings": liable, "maximum liable earnings": d(acc.maximumLiableEarnings) },
    output: round(liable.times(d(acc.rate)), R),
    legalRef: acc.legalRef,
    note: acc.note,
    unit: "money",
  });

  /* Income tax ------------------------------------------------------------------ */
  const scale = evaluateScale(gross, rules.brackets, R);
  const beforeCredit = trace.add({
    id: "nz-3",
    label: "Income tax before credits",
    formula: `brackets(${f(gross)})`,
    inputs: { "taxable income": gross },
    output: scale.total,
    legalRef: rules.brackets.legalRef,
    note: rules.brackets.note,
    bands: scale.rows,
    unit: "money",
  });

  /* Independent earner tax credit ------------------------------------------------ */
  const ie = rules.ietc;
  const eligible = readBool(v, "ietcEligible");
  let credit = ZERO;
  let creditFormula: string;
  if (!eligible) {
    creditFormula = "0 - eligibility not confirmed";
  } else if (gross.lt(d(ie.lowerThreshold)) || gross.gt(d(ie.upperThreshold))) {
    creditFormula = `0 - income is outside the ${f(d(ie.lowerThreshold))} to ${f(d(ie.upperThreshold))} window`;
  } else if (gross.lte(d(ie.fullCreditCeiling))) {
    credit = d(ie.amount);
    creditFormula = `${f(d(ie.amount))} - full credit`;
  } else {
    credit = floorZero(
      round(
        d(ie.amount).minus(gross.minus(d(ie.fullCreditCeiling)).times(d(ie.abatementRate))),
        R,
      ),
    );
    creditFormula = `${f(d(ie.amount))} - ${pct(d(ie.abatementRate))} x (${f(gross)} - ${f(d(ie.fullCreditCeiling))})`;
  }
  const creditUsed = min(credit, beforeCredit);

  trace.add({
    id: "nz-4",
    label: "Independent earner tax credit",
    formula: creditFormula,
    inputs: { "credit earned": credit, "credit used": creditUsed },
    output: creditUsed,
    legalRef: ie.legalRef,
    note: ie.note,
    unit: "money",
  });

  const tax = trace.add({
    id: "nz-5",
    label: "Income tax",
    formula: `max(0, ${f(beforeCredit)} - ${f(creditUsed)})`,
    inputs: { "before credits": beforeCredit, credit: creditUsed },
    output: floorZero(round(beforeCredit.minus(creditUsed), R)),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "nz-6",
    label: "Refund or tax to pay",
    formula: `${f(withheld)} (PAYE) - ${f(tax)}`,
    inputs: { PAYE: withheld, tax },
    output: round(withheld.minus(tax), R),
    unit: "money",
  });

  if (eligible && gross.gt(d(ie.fullCreditCeiling)) && gross.lt(d(ie.upperThreshold))) {
    warnings.push(
      "The independent earner tax credit is being withdrawn at 13 cents in the dollar over this range, which adds 13 points to your effective marginal rate.",
    );
  }
  warnings.push("KiwiSaver contributions are not modelled and will reduce your take-home pay further.");

  return { trace, grossAssessed: gross, social: levy, incomeTax: tax, withheld, months, warnings };
}

export const nzAdapter: CountryAdapter = {
  country: "NZ",
  currency: "NZD",
  label: "New Zealand",
  contributionLabel: "ACC earners' levy",
  regionLabel: "Jurisdiction",
  regionNote: "New Zealand income tax has no regional component, so there is one option here.",

  years: () => genericYears("NZ"),
  regions: (year) => genericRegions("NZ", year),

  fields(year): FieldSpec[] {
    return loadGeneric<NzRules>("NZ", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<NzRules>("NZ", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "NZ",
      currency: "NZD",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("nz", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
    });
  },
};
