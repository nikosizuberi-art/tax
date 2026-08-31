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
import au2026 from "../../rules/au/2026/national.json";

registerGeneric("AU", 2026, au2026);

interface AuRules extends GenericRuleset {
  scale: ScaleSpec;
  medicareLevy: {
    legalRef: string;
    rate: string;
    singleThreshold: string;
    shadeInCeiling: string;
    shadeInRate: string;
    note: string;
  };
  lowIncomeTaxOffset: {
    legalRef: string;
    maximum: string;
    taper1Start: string;
    taper1Rate: string;
    taper2Start: string;
    taper2Rate: string;
    zeroAt: string;
    note: string;
  };
  rounding: GenericRuleset["rounding"] & { finalTaxDp: number };
}

const f = (v: Decimal) => formatPlain(v, "AUD");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Australia's pipeline. Two features shape it:
 *
 *   - the Medicare levy is not a bracket. Below the threshold it is nil; in the
 *     shade-in range only 10 cents in the dollar of the EXCESS is charged; and
 *     once past the ceiling the full 2% applies to the WHOLE taxable income,
 *     not just the part above it.
 *   - the low income tax offset reduces tax but is non-refundable and withdrawn
 *     at two different rates, so it raises the effective marginal rate between
 *     AUD 37,500 and AUD 66,667 without appearing in any rate table.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<AuRules>("AU", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Assessable income ----------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "au-1",
    label: "Assessable income",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    note: "Employer superannuation is paid on top of your salary and is not part of assessable income.",
    unit: "money",
  });

  /* 2. Deductions ------------------------------------------------------------- */
  const work = readAnnual(v, "workExpenses");
  const donations = readAnnual(v, "donations");
  const superContrib = readAnnual(v, "concessionalSuper");
  const claimed = sum([work, donations, superContrib]);
  const allowed = min(claimed, gross);

  const deductions = trace.add({
    id: "au-2",
    label: "Deductions",
    formula: `${f(work)} (work-related) + ${f(donations)} (gifts) + ${f(superContrib)} (personal deductible super)`,
    inputs: {
      "work-related": work,
      gifts: donations,
      "personal deductible super": superContrib,
    },
    output: round(allowed, R),
    legalRef: "Division 8, Income Tax Assessment Act 1997",
    note: "A gift deduction cannot create or increase a tax loss, so deductions here are limited to your income.",
    unit: "money",
  });

  const taxable = trace.add({
    id: "au-3",
    label: "Taxable income",
    formula: `${f(gross)} - ${f(deductions)}`,
    inputs: { "assessable income": gross, deductions },
    output: floorZero(round(gross.minus(deductions), R)),
    unit: "money",
  });

  /* 3. Tax on taxable income --------------------------------------------------- */
  const scale = evaluateScale(taxable, rules.scale, R);
  const basicTax = trace.add({
    id: "au-4",
    label: "Tax on taxable income",
    formula: `rates(${f(taxable)})`,
    inputs: { "taxable income": taxable },
    output: scale.total,
    legalRef: rules.scale.legalRef,
    note: rules.scale.note,
    bands: scale.rows,
    unit: "money",
  });

  /* 4. Low income tax offset --------------------------------------------------- */
  const lito = rules.lowIncomeTaxOffset;
  const t1 = d(lito.taper1Start);
  const t2 = d(lito.taper2Start);
  let offset = d(lito.maximum);
  let offsetFormula = `${f(d(lito.maximum))} (full offset)`;
  if (taxable.gt(t2)) {
    const reduced = d(lito.maximum)
      .minus(t2.minus(t1).times(d(lito.taper1Rate)))
      .minus(taxable.minus(t2).times(d(lito.taper2Rate)));
    offset = floorZero(round(reduced, R));
    offsetFormula = `${f(d(lito.maximum))} - ${pct(d(lito.taper1Rate))} x (${f(t2)} - ${f(t1)}) - ${pct(d(lito.taper2Rate))} x (${f(taxable)} - ${f(t2)})`;
  } else if (taxable.gt(t1)) {
    offset = floorZero(
      round(d(lito.maximum).minus(taxable.minus(t1).times(d(lito.taper1Rate))), R),
    );
    offsetFormula = `${f(d(lito.maximum))} - ${pct(d(lito.taper1Rate))} x (${f(taxable)} - ${f(t1)})`;
  }
  // Non-refundable: it can reduce tax to nil but never below.
  const offsetUsed = min(offset, basicTax);

  const litoStep = trace.add({
    id: "au-5",
    label: "Low income tax offset",
    formula: offsetFormula,
    inputs: {
      "offset earned": offset,
      "offset used (non-refundable)": offsetUsed,
      "tax available to offset": basicTax,
    },
    output: offsetUsed,
    legalRef: lito.legalRef,
    note: lito.note,
    unit: "money",
  });

  const taxAfterOffset = trace.add({
    id: "au-6",
    label: "Tax after offsets",
    formula: `max(0, ${f(basicTax)} - ${f(litoStep)})`,
    inputs: { "tax on taxable income": basicTax, offset: litoStep },
    output: floorZero(round(basicTax.minus(litoStep), R)),
    unit: "money",
  });

  /* 5. Medicare levy, with its shade-in ---------------------------------------- */
  const ml = rules.medicareLevy;
  const threshold = d(ml.singleThreshold);
  const ceiling = d(ml.shadeInCeiling);
  let levy = ZERO;
  let levyFormula: string;
  if (taxable.lte(threshold)) {
    levyFormula = `0 - taxable income is at or below the threshold of ${f(threshold)}`;
  } else if (taxable.lte(ceiling)) {
    levy = round(taxable.minus(threshold).times(d(ml.shadeInRate)), R);
    levyFormula = `${pct(d(ml.shadeInRate))} x (${f(taxable)} - ${f(threshold)}) - the shade-in range`;
  } else {
    levy = round(taxable.times(d(ml.rate)), R);
    levyFormula = `${pct(d(ml.rate))} x ${f(taxable)} - the full levy on the whole taxable income`;
  }

  const levyStep = trace.add({
    id: "au-7",
    label: "Medicare levy",
    formula: levyFormula,
    inputs: { "taxable income": taxable, threshold, "shade-in ceiling": ceiling },
    output: levy,
    legalRef: ml.legalRef,
    note: ml.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "au-8",
    label: "Total tax payable",
    formula: `${f(taxAfterOffset)} (income tax) + ${f(levyStep)} (Medicare levy)`,
    inputs: { "income tax": taxAfterOffset, "Medicare levy": levyStep },
    output: round(taxAfterOffset.plus(levyStep), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "au-9",
    label: "Refund or amount owing",
    formula: `${f(withheld)} (PAYG withheld) - ${f(totalTax)} (tax payable)`,
    inputs: { "PAYG withheld": withheld, "tax payable": totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (taxable.gt(threshold) && taxable.lte(ceiling)) {
    warnings.push(
      "You are in the Medicare levy shade-in range, where each extra dollar carries an extra 10 cents of levy on top of your marginal tax rate.",
    );
  }
  if (taxable.gt(t1) && offset.gt(0)) {
    warnings.push(
      "The low income tax offset is being withdrawn at this income, which raises your effective marginal rate above the headline bracket rate.",
    );
  }

  return { trace, grossAssessed: gross, social: ZERO, incomeTax: totalTax, withheld, months, warnings };
}

export const auAdapter: CountryAdapter = {
  country: "AU",
  currency: "AUD",
  label: "Australia",
  contributionLabel: "Compulsory contributions",
  contributionNote:
    "The Medicare levy is part of the tax figure, and employer superannuation is paid on top of your salary.",
  regionLabel: "Jurisdiction",
  regionNote:
    "Australian income tax is federal only. The states raise payroll tax from employers rather than income tax from individuals, so there is one option here.",

  years: () => genericYears("AU"),
  regions: (year) => genericRegions("AU", year),

  fields(year): FieldSpec[] {
    return loadGeneric<AuRules>("AU", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<AuRules>("AU", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "AU",
      currency: "AUD",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("au", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "This figure includes the Medicare levy and the withdrawal of the low income tax offset, so it sits above the bracket rate between AUD 28,011 and AUD 66,667.",
    });
  },
};
