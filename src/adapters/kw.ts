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
import kw2026 from "../../rules/kw/2026/national.json";

registerGeneric("KW", 2026, kw2026);

interface KwRules extends GenericRuleset {
  personalIncomeTax: { levied: boolean; legalRef: string; note: string };
  socialInsurance: {
    legalRef: string;
    appliesTo: string;
    basicRate: string;
    basicMonthlyCeiling: string;
    supplementaryRate: string;
    supplementaryMonthlyCeiling: string;
    employerBasicRate: string;
    note: string;
  };
}

const f = (v: Decimal) => formatPlain(v, "KWD");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Kuwait's pipeline, which is mostly an absence of one. There is no personal
 * income tax law, so the income tax step is a constant zero with a citation
 * rather than a calculation. What remains is PIFSS social insurance, which
 * applies to Kuwaiti nationals only and has TWO separate monthly ceilings on
 * two separate rates - so it is not a single percentage of pay either.
 *
 * Modelling this properly matters: a generic "brackets with a zero rate" would
 * silently produce the right total for the wrong reason, and would not tell an
 * expatriate user that their gross pay is their take-home pay.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<KwRules>("KW", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Salary --------------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const income = trace.add({
    id: "kw-1",
    label: "Annual salary",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. PIFSS social insurance, Kuwaiti nationals only ------------------------ */
  const si = rules.socialInsurance;
  const status = readEnum(v, "nationality", "expatriate");
  const isKuwaiti = status === "kuwaiti";
  const basicCeiling = d(si.basicMonthlyCeiling);
  const suppCeiling = d(si.supplementaryMonthlyCeiling);
  const basicRate = d(si.basicRate);
  const suppRate = d(si.supplementaryRate);

  const monthlyContribution = monthlyGross.map((g) =>
    isKuwaiti
      ? round(min(g, basicCeiling).times(basicRate).plus(min(g, suppCeiling).times(suppRate)), R)
      : ZERO,
  );

  const social = trace.add({
    id: "kw-2",
    label: "PIFSS social insurance (employee share)",
    formula: isKuwaiti
      ? `sum over 12 months of ${pct(basicRate)} x min(salary, ${f(basicCeiling)}) + ${pct(suppRate)} x min(salary, ${f(suppCeiling)})`
      : "0 - expatriate workers make no social insurance contribution in Kuwait",
    inputs: {
      "basic rate": basicRate,
      "basic monthly ceiling": basicCeiling,
      "supplementary rate": suppRate,
      "supplementary monthly ceiling": suppCeiling,
    },
    output: round(sum(monthlyContribution), R),
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* 3. Income tax ------------------------------------------------------------ */
  const tax = trace.add({
    id: "kw-3",
    label: "Personal income tax",
    formula: "0 - Kuwait levies no personal income tax on individuals",
    inputs: { "annual salary": income },
    output: ZERO,
    legalRef: rules.personalIncomeTax.legalRef,
    note: rules.personalIncomeTax.note,
    unit: "money",
  });

  trace.add({
    id: "kw-4",
    label: "Net pay",
    formula: `${f(income)} - ${f(social)} (social insurance) - ${f(tax)} (income tax)`,
    inputs: { salary: income, "social insurance": social, "income tax": tax },
    output: round(income.minus(social), R),
    note: isKuwaiti
      ? "Your only compulsory deduction is PIFSS. There is no income tax to compute."
      : "As an expatriate worker you have no compulsory deduction at all: your gross pay is your take-home pay.",
    unit: "money",
  });

  if (!isKuwaiti && income.gt(0)) {
    warnings.push(
      "As an expatriate worker in Kuwait you pay neither income tax nor social insurance, so gross pay equals take-home pay. You may still be taxable on this income in your country of residence or citizenship - the United States taxes its citizens on worldwide income regardless of where they live.",
    );
  }
  if (isKuwaiti) {
    warnings.push(
      "PIFSS contributions are capped monthly at two different levels, so a salary above KWD 2,750 a month produces no further contribution.",
    );
  }

  return {
    trace,
    grossAssessed: income,
    social,
    incomeTax: tax,
    withheld: ZERO,
    months,
    warnings,
  };
}

export const kwAdapter: CountryAdapter = {
  country: "KW",
  currency: "KWD",
  label: "Kuwait",
  contributionLabel: "PIFSS social insurance",
  contributionNote:
    "Kuwaiti nationals only. Expatriate workers contribute nothing.",
  regionLabel: "Jurisdiction",
  regionNote:
    "Kuwait has no regional income tax or contribution variation, so there is only one option.",

  years: () => genericYears("KW"),
  regions: (year) => genericRegions("KW", year),

  fields(year): FieldSpec[] {
    return loadGeneric<KwRules>("KW", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<KwRules>("KW", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "KW",
      currency: "KWD",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("kw", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote: "The marginal income tax rate in Kuwait is zero at every income.",
    });
  },
};
