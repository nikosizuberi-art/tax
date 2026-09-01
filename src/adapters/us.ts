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
import us2026 from "../../rules/us/2026/national.json";

registerGeneric("US", 2026, us2026);

interface UsRegion extends GenericRegion {
  kind: "progressive" | "flat" | "none";
  standardDeduction: string;
  personalExemption?: string;
  exemptionCredit: string;
  scale: ScaleSpec;
}

interface UsRules extends GenericRuleset {
  federalBrackets: ScaleSpec;
  standardDeduction: { legalRef: string; amount: string; note: string };
  socialSecurity: {
    legalRef: string;
    oasdiRate: string;
    wageBase: string;
    medicareRate: string;
    additionalMedicareRate: string;
    additionalMedicareThreshold: string;
    note: string;
  };
}

const f = (v: Decimal) => formatPlain(v, "USD");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * The United States pipeline. Two things make it its own:
 *
 *   - FICA is not one tax. Social Security stops dead at the wage base while
 *     Medicare runs on forever and then GAINS a 0.9% surtax above a threshold,
 *     so the contribution rate falls and then rises again as pay increases.
 *   - The state computation is a second, independent pipeline with its own
 *     base. California starts from its own standard deduction and subtracts a
 *     credit at the end; Illinois grants an exemption instead of a deduction;
 *     Texas has no computation at all.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<UsRules>("US", input.year);
  const state = genericRegion<UsRegion>(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Wages ---------------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const wages = trace.add({
    id: "us-1",
    label: "Gross wages",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. FICA ----------------------------------------------------------------- */
  const ss = rules.socialSecurity;
  const wageBase = d(ss.wageBase);
  const oasdi = round(min(wages, wageBase).times(d(ss.oasdiRate)), R);
  const medicare = round(wages.times(d(ss.medicareRate)), R);
  const addlThreshold = d(ss.additionalMedicareThreshold);
  const addlMedicare = round(
    floorZero(wages.minus(addlThreshold)).times(d(ss.additionalMedicareRate)),
    R,
  );

  const fica = trace.add({
    id: "us-2",
    label: "FICA (Social Security and Medicare)",
    formula: `${pct(d(ss.oasdiRate))} x min(${f(wages)}, ${f(wageBase)}) = ${f(oasdi)}; Medicare ${pct(d(ss.medicareRate))} x ${f(wages)} = ${f(medicare)}; additional Medicare ${pct(d(ss.additionalMedicareRate))} above ${f(addlThreshold)} = ${f(addlMedicare)}`,
    inputs: {
      "Social Security": oasdi,
      "wage base": wageBase,
      Medicare: medicare,
      "additional Medicare": addlMedicare,
    },
    output: round(sum([oasdi, medicare, addlMedicare]), R),
    legalRef: ss.legalRef,
    note: ss.note,
    unit: "money",
  });

  /* 3. Adjusted gross and taxable income ------------------------------------ */
  const pretax = readAnnual(v, "pretax401k");
  const hsa = readAnnual(v, "hsa");
  const agi = trace.add({
    id: "us-3",
    label: "Adjusted gross income",
    formula: `${f(wages)} - ${f(pretax)} (401(k)) - ${f(hsa)} (HSA)`,
    inputs: { wages, "pre-tax retirement": pretax, HSA: hsa },
    output: floorZero(round(wages.minus(pretax).minus(hsa), R)),
    note: "Pre-tax retirement contributions reduce income tax but not FICA, which is why the two figures above and below differ.",
    unit: "money",
  });

  const stdDeduction = min(d(rules.standardDeduction.amount), agi);
  const taxable = trace.add({
    id: "us-4",
    label: "Federal taxable income",
    formula: `${f(agi)} - ${f(stdDeduction)} (standard deduction)`,
    inputs: { "adjusted gross income": agi, "standard deduction": stdDeduction },
    output: floorZero(round(agi.minus(stdDeduction), R)),
    legalRef: rules.standardDeduction.legalRef,
    note: rules.standardDeduction.note,
    unit: "money",
  });

  /* 4. Federal tax ----------------------------------------------------------- */
  const fedScale = evaluateScale(taxable, rules.federalBrackets, R);
  const federalTax = trace.add({
    id: "us-5",
    label: "Federal income tax",
    formula: `federal_brackets(${f(taxable)})`,
    inputs: { "taxable income": taxable },
    output: fedScale.total,
    legalRef: rules.federalBrackets.legalRef,
    note: rules.federalBrackets.note,
    bands: fedScale.rows,
    unit: "money",
  });

  /* 5. State tax - a separate computation on its own base -------------------- */
  let stateTax = ZERO;
  let stateFormula: string;
  let stateBands: typeof fedScale.rows | undefined;
  let stateBase = ZERO;

  if (state.kind === "none") {
    stateFormula = `0 - ${state.name} levies no individual income tax`;
  } else {
    const exemption = d(state.personalExemption ?? "0");
    stateBase = floorZero(round(agi.minus(d(state.standardDeduction)).minus(exemption), R));
    const scale = evaluateScale(stateBase, state.scale, R);
    stateBands = scale.rows;
    const credit = min(d(state.exemptionCredit), scale.total);
    stateTax = floorZero(round(scale.total.minus(credit), R));
    stateFormula = `${state.name.toLowerCase()}_brackets(${f(agi)} - ${f(d(state.standardDeduction))} deduction${exemption.gt(0) ? ` - ${f(exemption)} exemption` : ""}) ${credit.gt(0) ? `- ${f(credit)} exemption credit` : ""}`;
  }

  const stateStep = trace.add({
    id: "us-6",
    label: `${state.name} income tax`,
    formula: stateFormula,
    inputs: { "state taxable income": stateBase, "state tax": stateTax },
    output: stateTax,
    legalRef: state.scale.legalRef,
    note: state.scale.note,
    bands: stateBands,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "us-7",
    label: "Total income tax",
    formula: `${f(federalTax)} (federal) + ${f(stateStep)} (${state.name})`,
    inputs: { federal: federalTax, state: stateStep },
    output: round(federalTax.plus(stateStep), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "us-8",
    label: "Refund or balance due",
    formula: `${f(withheld)} (withheld) - ${f(totalTax)} (tax)`,
    inputs: { withheld, tax: totalTax },
    output: round(withheld.minus(totalTax), R),
    note: "FICA is not part of this comparison. It is withheld separately and is never reconciled on the return.",
    unit: "money",
  });

  if (wages.gt(wageBase)) {
    warnings.push(
      `Your wages passed the Social Security wage base of ${f(wageBase)}, so Social Security tax stopped for the rest of the year. Medicare did not.`,
    );
  }
  if (wages.gt(addlThreshold)) {
    warnings.push(
      "The additional 0.9% Medicare tax applies to your wages above the threshold. Your employer withholds it but does not match it.",
    );
  }
  warnings.push(
    "Single filer only. Filing jointly, as head of household, or claiming children would change this figure materially.",
  );

  return { trace, grossAssessed: wages, social: fica, incomeTax: totalTax, withheld, months, warnings };
}

export const usAdapter: CountryAdapter = {
  country: "US",
  currency: "USD",
  label: "United States",
  contributionLabel: "FICA",
  regionLabel: "State",
  regionNote:
    "State income tax is a separate computation with its own base, its own deductions and its own rates. California's top rate is 13.3%; Texas has no income tax at all. A federal-only figure would be misleading.",

  years: () => genericYears("US"),
  regions: (year) => genericRegions("US", year),

  fields(year): FieldSpec[] {
    return loadGeneric<UsRules>("US", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<UsRules>("US", input.year);
    const region = genericRegion<UsRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "US",
      currency: "USD",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("us", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Above the Social Security wage base the contribution rate drops by 6.2 points, so take-home pay jumps mid-year even though gross pay has not changed.",
    });
  },
};
