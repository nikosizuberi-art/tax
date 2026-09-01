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
import { readMonthly, readAnnual, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import za2026 from "../../rules/za/2026/national.json";

registerGeneric("ZA", 2026, za2026);

interface ZaRules extends GenericRuleset {
  brackets: ScaleSpec;
  rebates: {
    legalRef: string;
    primary: string;
    secondary65: string;
    tertiary75: string;
    note: string;
  };
  uif: { legalRef: string; employeeRate: string; monthlyCeiling: string; note: string };
  retirementDeduction: {
    legalRef: string;
    percentOfIncome: string;
    annualCap: string;
    note: string;
  };
}

const f = (v: Decimal) => formatPlain(v, "ZAR");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * South Africa's pipeline. There is no tax-free band in the rate table: tax
 * starts at 18% from the first rand and the tax-free effect comes entirely from
 * a REBATE against the tax. That is why the threshold is exactly the rebate
 * divided by the first rate, and it means the relief is worth the same to
 * everyone rather than being worth more to a higher-rate taxpayer.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<ZaRules>("ZA", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "za-1",
    label: "Gross remuneration",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* UIF, capped monthly ---------------------------------------------------------- */
  const uifSpec = rules.uif;
  const uifCeiling = d(uifSpec.monthlyCeiling);
  const uif = trace.add({
    id: "za-2",
    label: "UIF contributions",
    formula: `sum over 12 months of ${pct(d(uifSpec.employeeRate))} x min(monthly pay, ${f(uifCeiling)})`,
    inputs: { "monthly ceiling": uifCeiling, rate: d(uifSpec.employeeRate) },
    output: round(
      sum(monthlyGross.map((g) => min(g, uifCeiling).times(d(uifSpec.employeeRate)))),
      R,
    ),
    legalRef: uifSpec.legalRef,
    note: uifSpec.note,
    unit: "money",
  });

  /* Retirement contributions ------------------------------------------------------ */
  const rd = rules.retirementDeduction;
  const claimed = readAnnual(v, "retirementContributions");
  const limit = min(round(gross.times(d(rd.percentOfIncome)), R), d(rd.annualCap));
  const allowed = min(claimed, limit);

  const taxable = trace.add({
    id: "za-3",
    label: "Taxable income",
    formula: `${f(gross)} - ${f(allowed)} (retirement contributions, limited to ${f(limit)})`,
    inputs: { gross, claimed, limit, allowed },
    output: floorZero(round(gross.minus(allowed), R)),
    legalRef: rd.legalRef,
    note: rd.note,
    unit: "money",
  });

  /* Tax before rebates ------------------------------------------------------------- */
  const scale = evaluateScale(taxable, rules.brackets, R);
  const before = trace.add({
    id: "za-4",
    label: "Tax before rebates",
    formula: `brackets(${f(taxable)})`,
    inputs: { "taxable income": taxable },
    output: scale.total,
    legalRef: rules.brackets.legalRef,
    note: rules.brackets.note,
    bands: scale.rows,
    unit: "money",
  });

  /* Rebate --------------------------------------------------------------------------- */
  const rebate = min(d(rules.rebates.primary), before);
  trace.add({
    id: "za-5",
    label: "Primary rebate",
    formula: `${f(d(rules.rebates.primary))}, limited to the tax due`,
    inputs: { "primary rebate": d(rules.rebates.primary), applied: rebate },
    output: rebate,
    legalRef: rules.rebates.legalRef,
    note: rules.rebates.note,
    unit: "money",
  });

  const tax = trace.add({
    id: "za-6",
    label: "Normal tax payable",
    formula: `max(0, ${f(before)} - ${f(rebate)})`,
    inputs: { "before rebates": before, rebate },
    output: floorZero(round(before.minus(rebate), R)),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "za-7",
    label: "Refund or amount owing",
    formula: `${f(withheld)} (PAYE) - ${f(tax)}`,
    inputs: { PAYE: withheld, tax },
    output: round(withheld.minus(tax), R),
    unit: "money",
  });

  if (claimed.gt(allowed)) {
    warnings.push(
      `Retirement contributions were limited to ${f(limit)}, being 27.5% of remuneration and never more than ${f(d(rd.annualCap))}.`,
    );
  }

  return { trace, grossAssessed: gross, social: uif, incomeTax: tax, withheld, months, warnings };
}

export const zaAdapter: CountryAdapter = {
  country: "ZA",
  currency: "ZAR",
  label: "South Africa",
  contributionLabel: "UIF",
  regionLabel: "Jurisdiction",
  regionNote: "South African income tax has no provincial component, so there is one option here.",

  years: () => genericYears("ZA"),
  regions: (year) => genericRegions("ZA", year),

  fields(year): FieldSpec[] {
    return loadGeneric<ZaRules>("ZA", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<ZaRules>("ZA", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "ZA",
      currency: "ZAR",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("za", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Below the ZAR 99,000 threshold the rebate absorbs the whole charge, so the marginal rate is nil until the rebate runs out.",
    });
  },
};
