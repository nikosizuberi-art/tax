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
import { readMonthly, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import kr2026 from "../../rules/kr/2026/national.json";

registerGeneric("KR", 2026, kr2026);

interface KrTier {
  upTo: string | null;
  base: string;
  from: string;
  rate: string;
}

interface KrRules extends GenericRuleset {
  earnedIncomeDeduction: { legalRef: string; cap: string; note: string; tiers: KrTier[] };
  personalDeduction: { legalRef: string; basic: string; note: string };
  brackets: ScaleSpec;
  localIncomeTax: { legalRef: string; rate: string; note: string };
  socialInsurance: {
    legalRef: string;
    pensionRate: string;
    healthRate: string;
    longTermCareRateOfHealth: string;
    employmentRate: string;
    note: string;
  };
}

const LOCALE = "ko-KR";
const f = (v: Decimal) => formatPlain(v, "KRW", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(3).replace(/\.?0+$/, "")}%`;

/**
 * Korea's pipeline. Two mechanisms are worth naming. The earned income
 * deduction is a sharply regressive formula - 70% of the first tranche, 2% at
 * the top - so it shrinks as a share of pay and the effective rate rises even
 * within a single bracket. And long-term care insurance is charged as a
 * percentage OF THE HEALTH INSURANCE PREMIUM rather than of salary, which is a
 * contribution on a contribution.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<KrRules>("KR", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "kr-1",
    label: "Gross salary",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* Social insurance ------------------------------------------------------------------ */
  const si = rules.socialInsurance;
  const pension = round(gross.times(d(si.pensionRate)), R);
  const health = round(gross.times(d(si.healthRate)), R);
  const longTermCare = round(health.times(d(si.longTermCareRateOfHealth)), R);
  const employment = round(gross.times(d(si.employmentRate)), R);
  const social = trace.add({
    id: "kr-2",
    label: "Four major insurances (employee share)",
    formula: `pension ${pct(d(si.pensionRate))} = ${f(pension)}; health ${pct(d(si.healthRate))} = ${f(health)}; long-term care ${pct(d(si.longTermCareRateOfHealth))} OF THE HEALTH PREMIUM = ${f(longTermCare)}; employment ${pct(d(si.employmentRate))} = ${f(employment)}`,
    inputs: {
      "national pension": pension,
      "health insurance": health,
      "long-term care": longTermCare,
      "employment insurance": employment,
    },
    output: round(sum([pension, health, longTermCare, employment]), R),
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* Earned income deduction ------------------------------------------------------------- */
  const eid = rules.earnedIncomeDeduction;
  const tier =
    eid.tiers.find((t) => t.upTo === null || gross.lte(d(t.upTo))) ??
    eid.tiers[eid.tiers.length - 1];
  const deduction = min(
    min(round(d(tier.base).plus(gross.minus(d(tier.from)).times(d(tier.rate))), R), d(eid.cap)),
    gross,
  );

  trace.add({
    id: "kr-3",
    label: "Earned income deduction",
    formula: `${f(d(tier.base))} + ${pct(d(tier.rate))} x (${f(gross)} - ${f(d(tier.from))}), capped at ${f(d(eid.cap))}`,
    inputs: { "gross salary": gross, deduction, cap: d(eid.cap) },
    output: deduction,
    legalRef: eid.legalRef,
    note: eid.note,
    unit: "money",
  });

  /* Taxable income ----------------------------------------------------------------------- */
  const basic = d(rules.personalDeduction.basic);
  const taxable = trace.add({
    id: "kr-4",
    label: "Taxable income",
    formula: `${f(gross)} - ${f(deduction)} (earned income deduction) - ${f(basic)} (basic personal deduction)`,
    inputs: { gross, "earned income deduction": deduction, "basic deduction": basic },
    output: floorZero(round(gross.minus(deduction).minus(basic), R)),
    legalRef: rules.personalDeduction.legalRef,
    note: rules.personalDeduction.note,
    unit: "money",
  });

  /* National tax --------------------------------------------------------------------------- */
  const scale = evaluateScale(taxable, rules.brackets, R);
  const nationalTax = trace.add({
    id: "kr-5",
    label: "National income tax",
    formula: `brackets(${f(taxable)})`,
    inputs: { "taxable income": taxable },
    output: scale.total,
    legalRef: rules.brackets.legalRef,
    note: rules.brackets.note,
    bands: scale.rows,
    unit: "money",
  });

  /* Local income tax ------------------------------------------------------------------------ */
  const local = trace.add({
    id: "kr-6",
    label: "Local income tax",
    formula: `${pct(d(rules.localIncomeTax.rate))} x ${f(nationalTax)}`,
    inputs: { "national income tax": nationalTax },
    output: round(nationalTax.times(d(rules.localIncomeTax.rate)), R),
    legalRef: rules.localIncomeTax.legalRef,
    note: rules.localIncomeTax.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "kr-7",
    label: "Total income tax",
    formula: `${f(nationalTax)} (national) + ${f(local)} (local)`,
    inputs: { national: nationalTax, local },
    output: round(nationalTax.plus(local), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "kr-8",
    label: "Year-end settlement",
    formula: `${f(withheld)} (withheld) - ${f(totalTax)}`,
    inputs: { withheld, tax: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  warnings.push(
    "The earned income tax credit is not modelled, so this figure overstates the tax for most employees.",
  );

  return { trace, grossAssessed: gross, social, incomeTax: totalTax, withheld, months, warnings };
}

export const krAdapter: CountryAdapter = {
  country: "KR",
  currency: "KRW",
  locale: LOCALE,
  label: "South Korea",
  contributionLabel: "Four major insurances",
  regionLabel: "Jurisdiction",
  regionNote:
    "Local income tax is a flat 10% of the national tax everywhere in Korea, so there is no regional choice here.",

  years: () => genericYears("KR"),
  regions: (year) => genericRegions("KR", year),

  fields(year): FieldSpec[] {
    return loadGeneric<KrRules>("KR", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<KrRules>("KR", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "KR",
      currency: "KRW",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("kr", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      probe: new Decimal(100000),
      marginalNote: "Measured over KRW 100,000, because the won has no minor units.",
    });
  },
};
