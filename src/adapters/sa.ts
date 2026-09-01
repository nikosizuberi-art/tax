import { Decimal, d, ZERO, min, sum, round, formatPlain, type Rounding } from "../engine/money";
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
import { readMonthly, readEnum, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import sa2026 from "../../rules/sa/2026/national.json";

registerGeneric("SA", 2026, sa2026);

interface SaRules extends GenericRuleset {
  personalIncomeTax: { levied: boolean; legalRef: string; note: string };
  socialInsurance: {
    legalRef: string;
    appliesTo: string;
    employeeRate: string;
    monthlyCeiling: string;
    employerRate: string;
    nonSaudiEmployerRate: string;
    note: string;
  };
}

const f = (v: Decimal) => formatPlain(v, "SAR");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Saudi Arabia, like Kuwait, has no income tax step to compute. What it does
 * have is a contribution that depends on nationality and is charged on a
 * narrower base than total pay, with a monthly ceiling. Modelling it as "zero
 * tax" alone would tell a Saudi national nothing useful and would tell an
 * expatriate the wrong thing about why their pay is untouched.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<SaRules>("SA", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const pay = trace.add({
    id: "sa-1",
    label: "Basic salary plus housing for the year",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  const si = rules.socialInsurance;
  const isSaudi = readEnum(v, "nationality", "expatriate") === "saudi";
  const ceiling = d(si.monthlyCeiling);
  const rate = d(si.employeeRate);
  const gosi = trace.add({
    id: "sa-2",
    label: "GOSI contributions (employee share)",
    formula: isSaudi
      ? `sum over 12 months of ${pct(rate)} x min(monthly pay, ${f(ceiling)})`
      : "0 - an expatriate employee makes no GOSI contribution",
    inputs: { "employee rate": rate, "monthly ceiling": ceiling },
    output: isSaudi
      ? round(sum(monthlyGross.map((g) => min(g, ceiling).times(rate))), R)
      : ZERO,
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  const tax = trace.add({
    id: "sa-3",
    label: "Personal income tax",
    formula: "0 - Saudi Arabia levies no income tax on employment income",
    inputs: { "pay for the year": pay },
    output: ZERO,
    legalRef: rules.personalIncomeTax.legalRef,
    note: rules.personalIncomeTax.note,
    unit: "money",
  });

  trace.add({
    id: "sa-4",
    label: "Net pay",
    formula: `${f(pay)} - ${f(gosi)} (GOSI) - ${f(tax)} (income tax)`,
    inputs: { pay, GOSI: gosi },
    output: round(pay.minus(gosi), R),
    note: isSaudi
      ? "GOSI is your only compulsory deduction. There is no income tax to compute."
      : "As an expatriate employee you have no compulsory deduction at all.",
    unit: "money",
  });

  if (!isSaudi && pay.gt(0)) {
    warnings.push(
      "As an expatriate employee in Saudi Arabia you pay neither income tax nor social insurance. You may still be taxable on this income in your country of residence or citizenship.",
    );
  }

  return { trace, grossAssessed: pay, social: gosi, incomeTax: tax, withheld: ZERO, months, warnings };
}

export const saAdapter: CountryAdapter = {
  country: "SA",
  currency: "SAR",
  label: "Saudi Arabia",
  contributionLabel: "GOSI",
  contributionNote: "Saudi nationals only, on basic salary plus housing.",
  hasWithholding: false,
  regionLabel: "Jurisdiction",
  regionNote: "No regional variation in either tax or contributions.",

  years: () => genericYears("SA"),
  regions: (year) => genericRegions("SA", year),

  fields(year): FieldSpec[] {
    return loadGeneric<SaRules>("SA", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<SaRules>("SA", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "SA",
      currency: "SAR",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("sa", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote: "The marginal income tax rate in Saudi Arabia is zero at every income.",
    });
  },
};
