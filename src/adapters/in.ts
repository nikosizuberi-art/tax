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
import in2026 from "../../rules/in/2026/national.json";

registerGeneric("IN", 2026, in2026);

interface InRules extends GenericRuleset {
  regime: { legalRef: string; name: string; standardDeduction: string; note: string };
  scale: ScaleSpec;
  rebate87A: { legalRef: string; incomeLimit: string; maximum: string; note: string };
  surcharge: {
    legalRef: string;
    note: string;
    tiers: Array<{ threshold: string; rate: string }>;
  };
  cess: { legalRef: string; rate: string; note: string };
  rounding: GenericRuleset["rounding"] & { finalTaxNearest: string };
}

const f = (v: Decimal) => formatPlain(v, "INR", "en-IN");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * India's pipeline, under the default new regime. It has THREE mechanisms that
 * a bracket model cannot express:
 *
 *   - a rebate under s. 87A that wipes out the tax entirely up to a threshold,
 *     with marginal relief so the first rupee over the line does not cost
 *     tens of thousands;
 *   - a surcharge charged on the TAX, in tiers, each with its own marginal
 *     relief;
 *   - a 4% cess charged on tax plus surcharge, after everything else.
 *
 * The two marginal reliefs are the whole reason the effective marginal rate
 * just above INR 12,00,000 is 100% rather than 15%.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<InRules>("IN", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };
  const nearest = d(rules.rounding.finalTaxNearest);

  /* 1. Gross salary ---------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "in-1",
    label: "Gross salary",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. Standard deduction and the one surviving employer deduction ---------- */
  const standard = min(d(rules.regime.standardDeduction), gross);
  const employerNps = readAnnual(v, "employerNps");
  const epf = readAnnual(v, "epf");

  const totalIncome = trace.add({
    id: "in-2",
    label: "Total income",
    formula: `${f(gross)} - ${f(standard)} (standard deduction) - ${f(employerNps)} (employer NPS under s. 80CCD(2))`,
    inputs: {
      "gross salary": gross,
      "standard deduction": standard,
      "employer NPS": employerNps,
      "employee EPF (not deductible)": epf,
    },
    output: floorZero(round(gross.minus(standard).minus(employerNps), R)),
    legalRef: rules.regime.legalRef,
    note: "Your own EPF contribution is shown for information only. Under the new regime it is not deductible, so it reduces your take-home pay without reducing your tax.",
    unit: "money",
  });

  /* 3. Tax on the slabs ------------------------------------------------------- */
  const scale = evaluateScale(totalIncome, rules.scale, R);
  const slabTax = trace.add({
    id: "in-3",
    label: "Tax on total income (slab rates)",
    formula: `slabs(${f(totalIncome)})`,
    inputs: { "total income": totalIncome },
    output: scale.total,
    legalRef: rules.scale.legalRef,
    bands: scale.rows,
    unit: "money",
  });

  /* 4. Rebate under s. 87A, with marginal relief ----------------------------- */
  const reb = rules.rebate87A;
  const limit = d(reb.incomeLimit);
  let rebate = ZERO;
  let rebateFormula: string;
  if (totalIncome.lte(limit)) {
    rebate = min(slabTax, d(reb.maximum));
    rebateFormula = `min(${f(slabTax)}, ${f(d(reb.maximum))}) - total income is within ${f(limit)}`;
  } else {
    // Marginal relief: the tax may not exceed the income above the threshold.
    const excess = totalIncome.minus(limit);
    const relief = floorZero(slabTax.minus(excess));
    rebate = relief;
    rebateFormula = relief.gt(0)
      ? `marginal relief: tax of ${f(slabTax)} is capped at the ${f(excess)} by which income exceeds ${f(limit)}`
      : `0 - income exceeds ${f(limit)} by more than the tax due, so no relief applies`;
  }

  const afterRebate = trace.add({
    id: "in-4",
    label: "Rebate under s. 87A and marginal relief",
    formula: rebateFormula,
    inputs: { "tax on slabs": slabTax, "total income": totalIncome, "rebate limit": limit },
    output: round(rebate, R),
    legalRef: reb.legalRef,
    note: reb.note,
    unit: "money",
  });

  const taxAfterRebate = trace.add({
    id: "in-5",
    label: "Tax after rebate",
    formula: `max(0, ${f(slabTax)} - ${f(afterRebate)})`,
    inputs: { "tax on slabs": slabTax, rebate: afterRebate },
    output: floorZero(round(slabTax.minus(afterRebate), R)),
    unit: "money",
  });

  /* 5. Surcharge on the tax, in tiers, each with marginal relief -------------- */
  const sc = rules.surcharge;
  let surchargeRate = ZERO;
  let tierThreshold = ZERO;
  for (const tier of sc.tiers) {
    if (totalIncome.gt(d(tier.threshold))) {
      surchargeRate = d(tier.rate);
      tierThreshold = d(tier.threshold);
    }
  }
  let surcharge = round(taxAfterRebate.times(surchargeRate), R);
  let surchargeFormula = surchargeRate.gt(0)
    ? `${pct(surchargeRate)} x ${f(taxAfterRebate)}`
    : "0 - total income is below the first surcharge threshold";

  if (surchargeRate.gt(0)) {
    // Marginal relief: tax plus surcharge may not exceed the tax at the
    // threshold plus the whole of the income above it.
    const taxAtThreshold = evaluateScale(tierThreshold, rules.scale, R).total;
    const incomeAbove = totalIncome.minus(tierThreshold);
    const ceiling = taxAtThreshold.plus(incomeAbove);
    if (taxAfterRebate.plus(surcharge).gt(ceiling)) {
      surcharge = floorZero(round(ceiling.minus(taxAfterRebate), R));
      surchargeFormula = `marginal relief: tax plus surcharge capped at ${f(taxAtThreshold)} (tax at ${f(tierThreshold)}) + ${f(incomeAbove)} (income above it)`;
      warnings.push(
        "Marginal relief has reduced your surcharge, so crossing the threshold has not cost you more than the extra income you earned.",
      );
    }
  }

  const surchargeStep = trace.add({
    id: "in-6",
    label: "Surcharge",
    formula: surchargeFormula,
    inputs: { "tax after rebate": taxAfterRebate, "surcharge rate": surchargeRate },
    output: surcharge,
    legalRef: sc.legalRef,
    note: sc.note,
    unit: "money",
  });

  /* 6. Cess on tax plus surcharge --------------------------------------------- */
  const cessRate = d(rules.cess.rate);
  const cess = trace.add({
    id: "in-7",
    label: "Health and education cess",
    formula: `${pct(cessRate)} x (${f(taxAfterRebate)} + ${f(surchargeStep)})`,
    inputs: { "tax after rebate": taxAfterRebate, surcharge: surchargeStep, rate: cessRate },
    output: round(taxAfterRebate.plus(surchargeStep).times(cessRate), R),
    legalRef: rules.cess.legalRef,
    note: rules.cess.note,
    unit: "money",
  });

  /* 7. Total, rounded to the nearest ten rupees ------------------------------- */
  const raw = taxAfterRebate.plus(surchargeStep).plus(cess);
  const totalTax = trace.add({
    id: "in-8",
    label: "Total tax payable",
    formula: `${f(taxAfterRebate)} + ${f(surchargeStep)} + ${f(cess)}, rounded to the nearest ${nearest.toString()} rupees`,
    inputs: { "tax after rebate": taxAfterRebate, surcharge: surchargeStep, cess },
    output: raw.dividedBy(nearest).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(nearest),
    legalRef: "s. 288B Income-tax Act 1961",
    note: "Section 288B requires the final liability to be rounded to the nearest multiple of ten rupees.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "in-9",
    label: "Refund or amount payable",
    formula: `${f(withheld)} (TDS deducted) - ${f(totalTax)} (tax payable)`,
    inputs: { TDS: withheld, "tax payable": totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (totalIncome.gt(limit) && rebate.gt(0)) {
    warnings.push(
      "You are just above the rebate threshold, so marginal relief is holding your tax down to the amount by which your income exceeds it. Every extra rupee here is effectively taxed at 100% until the relief runs out.",
    );
  }

  return {
    trace,
    grossAssessed: gross,
    social: epf,
    incomeTax: totalTax,
    withheld,
    months,
    warnings,
  };
}

export const inAdapter: CountryAdapter = {
  country: "IN",
  currency: "INR",
  locale: "en-IN",
  label: "India",
  contributionLabel: "Provident fund",
  contributionNote:
    "Not deductible under the new regime, so it reduces take-home pay without reducing tax.",
  regionLabel: "Jurisdiction",
  regionNote: "Indian income tax has no state component, so there is only one option.",

  years: () => genericYears("IN"),
  regions: (year) => genericRegions("IN", year),

  fields(year): FieldSpec[] {
    return loadGeneric<InRules>("IN", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<InRules>("IN", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "IN",
      currency: "INR",
      locale: "en-IN",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("in", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Just above INR 12,00,000 the marginal rate is effectively 100% while marginal relief runs off, and it is far above the slab rate at each surcharge threshold for the same reason.",
    });
  },
};
