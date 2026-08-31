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
import { readMonthly, readAnnual, readInt, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import hk2026 from "../../rules/hk/2026/national.json";

registerGeneric("HK", 2026, hk2026);

interface HkRules extends GenericRuleset {
  progressiveScale: ScaleSpec;
  standardScale: ScaleSpec;
  mpf: {
    legalRef: string;
    employeeRate: string;
    minMonthlyIncome: string;
    maxMonthlyIncome: string;
    annualDeductionCap: string;
    note: string;
  };
  allowances: {
    legalRef: string;
    basic: string;
    child: string;
    childBornDuringYearExtra: string;
    dependentParent60Plus: string;
    dependentParentResidingExtra: string;
  };
  deductionCaps: Record<string, string>;
  oneOffReduction: { percent: string; ceiling: string } | null;
  rounding: GenericRuleset["rounding"] & { finalTaxDp: number; finalTaxMode: "down" };
}

const f = (v: Decimal) => formatPlain(v, "HKD");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Hong Kong's pipeline. Salaries tax is computed TWICE and the taxpayer pays
 * the lower figure:
 *
 *   - progressive rates on net chargeable income, which is income after
 *     deductions AND after personal allowances;
 *   - the two-tiered standard rate on net income, which is income after
 *     deductions but BEFORE any allowance.
 *
 * That means allowances are worth nothing to a high earner already on the
 * standard rate, and the marginal rate falls from 17% back to 15% once the
 * standard-rate computation takes over. No bracket-plus-allowance model
 * reproduces that.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<HkRules>("HK", input.year);
  genericRegion(rules, input.regionCode); // rejects an unknown region
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };
  const FINAL: Rounding = { dp: rules.rounding.finalTaxDp, mode: rules.rounding.finalTaxMode };

  /* 1. Assessable income --------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const income = trace.add({
    id: "hk-1",
    label: "Assessable income",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    legalRef: "s. 8, Inland Revenue Ordinance",
    note:
      months === 12
        ? undefined
        : `Only ${months} month(s) carry income. A partial year is taxed on the actual total; it is never annualised.`,
    unit: "money",
  });

  /* 2. MPF mandatory contributions ----------------------------------------- */
  const mpf = rules.mpf;
  const mpfMin = d(mpf.minMonthlyIncome);
  const mpfMax = d(mpf.maxMonthlyIncome);
  const mpfRate = d(mpf.employeeRate);
  const override = readAnnual(v, "mpfOverride");
  const monthlyMpf = monthlyGross.map((g) =>
    g.lt(mpfMin) ? ZERO : round(min(g, mpfMax).times(mpfRate), R),
  );
  const mpfPaid = override.gt(0) ? override : round(sum(monthlyMpf), R);
  const belowMinMonths = monthlyGross.filter((g) => g.gt(0) && g.lt(mpfMin)).length;

  trace.add({
    id: "hk-2",
    label: "MPF mandatory contributions",
    formula: override.gt(0)
      ? "amount you entered (override)"
      : `sum over 12 months of ${pct(mpfRate)} x min(monthly income, ${f(mpfMax)}), nil in a month below ${f(mpfMin)}`,
    inputs: {
      "employee rate": mpfRate,
      "minimum relevant income": mpfMin,
      "maximum relevant income": mpfMax,
    },
    output: mpfPaid,
    legalRef: mpf.legalRef,
    note:
      belowMinMonths > 0
        ? `${belowMinMonths} month(s) fell below the minimum relevant income, so no employee contribution was due in those months.`
        : mpf.note,
    unit: "money",
  });

  const mpfDeductible = min(mpfPaid, d(mpf.annualDeductionCap));

  /* 3. Allowable deductions ------------------------------------------------ */
  const caps = rules.deductionCaps;
  const selfEducation = min(readAnnual(v, "selfEducation"), d(caps.selfEducation));
  const homeLoan = min(readAnnual(v, "homeLoanInterest"), d(caps.homeLoanInterest));
  const rent = min(readAnnual(v, "domesticRent"), d(caps.domesticRent));
  const vhis = min(readAnnual(v, "voluntaryHealthInsurance"), d(caps.voluntaryHealthInsurance));
  const annuity = min(readAnnual(v, "annuityAndTvc"), d(caps.annuityAndTvc));

  if (homeLoan.gt(0) && rent.gt(0)) {
    warnings.push(
      "You claimed both home loan interest and domestic rent. They cannot both be claimed for the same year of assessment; this estimate has allowed both, so treat the figure as an upper bound.",
    );
  }

  const nonDonationDeductions = sum([mpfDeductible, selfEducation, homeLoan, rent, vhis, annuity]);
  const donationCeiling = floorZero(
    round(income.minus(nonDonationDeductions).times(d(caps.donationsPercentOfIncome)), R),
  );
  const donationsGiven = readAnnual(v, "donations");
  const donations = min(donationsGiven, donationCeiling);
  if (donationsGiven.gt(donations)) {
    warnings.push(
      `Approved charitable donations were limited to 35% of income after the other deductions (${f(donationCeiling)}).`,
    );
  }

  const deductions = trace.add({
    id: "hk-3",
    label: "Allowable deductions",
    formula: `${f(mpfDeductible)} (MPF, cap ${f(d(mpf.annualDeductionCap))}) + ${f(selfEducation)} (self-education) + ${f(homeLoan)} (home loan interest) + ${f(rent)} (domestic rent) + ${f(vhis)} (VHIS) + ${f(annuity)} (annuity and TVC) + ${f(donations)} (donations)`,
    inputs: {
      "MPF allowed": mpfDeductible,
      "self-education": selfEducation,
      "home loan interest": homeLoan,
      "domestic rent": rent,
      VHIS: vhis,
      "annuity and TVC": annuity,
      donations,
    },
    output: round(nonDonationDeductions.plus(donations), R),
    legalRef: "ss. 12, 26D, 26E, 26G-26K, Inland Revenue Ordinance",
    unit: "money",
  });

  /* 4. Net income - the base for the standard rate -------------------------- */
  const netIncome = trace.add({
    id: "hk-4",
    label: "Net income (before allowances)",
    formula: `${f(income)} - ${f(deductions)}`,
    inputs: { "assessable income": income, deductions },
    output: floorZero(round(income.minus(deductions), R)),
    note: "This is the base for the standard rate computation. Personal allowances are deliberately not subtracted here.",
    unit: "money",
  });

  /* 5. Personal allowances -------------------------------------------------- */
  const a = rules.allowances;
  const children = readInt(v, "children");
  const born = Math.min(readInt(v, "childrenBornThisYear"), children);
  const parents = readInt(v, "dependentParents");
  const parentsResiding = Math.min(readInt(v, "dependentParentsResiding"), parents);

  const childAllowance = d(a.child).times(children).plus(d(a.childBornDuringYearExtra).times(born));
  const parentAllowance = d(a.dependentParent60Plus)
    .times(parents)
    .plus(d(a.dependentParentResidingExtra).times(parentsResiding));

  const allowances = trace.add({
    id: "hk-5",
    label: "Personal allowances",
    formula: `${f(d(a.basic))} (basic) + ${f(childAllowance)} (${children} child allowance(s), ${born} born this year) + ${f(parentAllowance)} (${parents} dependent parent(s), ${parentsResiding} residing with you)`,
    inputs: {
      basic: d(a.basic),
      "child allowances": childAllowance,
      "dependent parent allowances": parentAllowance,
    },
    output: round(d(a.basic).plus(childAllowance).plus(parentAllowance), R),
    legalRef: a.legalRef,
    unit: "money",
  });

  /* 6. Net chargeable income ------------------------------------------------ */
  const netChargeable = trace.add({
    id: "hk-6",
    label: "Net chargeable income",
    formula: `max(0, ${f(netIncome)} - ${f(allowances)})`,
    inputs: { "net income": netIncome, allowances },
    output: floorZero(round(netIncome.minus(allowances), R)),
    note: "This is the base for the progressive computation.",
    unit: "money",
  });

  /* 7 and 8. The two computations ------------------------------------------- */
  const progressive = evaluateScale(netChargeable, rules.progressiveScale, R);
  const progressiveTax = trace.add({
    id: "hk-7",
    label: "Tax at progressive rates",
    formula: `progressive(${f(netChargeable)})`,
    inputs: { "net chargeable income": netChargeable },
    output: progressive.total,
    legalRef: rules.progressiveScale.legalRef,
    note: rules.progressiveScale.note,
    bands: progressive.rows,
    unit: "money",
  });

  const standard = evaluateScale(netIncome, rules.standardScale, R);
  const standardTax = trace.add({
    id: "hk-8",
    label: "Tax at the two-tiered standard rate",
    formula: `standard(${f(netIncome)})`,
    inputs: { "net income": netIncome },
    output: standard.total,
    legalRef: rules.standardScale.legalRef,
    note: rules.standardScale.note,
    bands: standard.rows,
    unit: "money",
  });

  /* 9. The lower of the two -------------------------------------------------- */
  const lower = min(progressiveTax, standardTax);
  const usingStandard = standardTax.lt(progressiveTax);
  let tax = trace.add({
    id: "hk-9",
    label: "Tax payable before any reduction",
    formula: `min(${f(progressiveTax)} progressive, ${f(standardTax)} standard) = ${f(lower)}`,
    inputs: { progressive: progressiveTax, standard: standardTax },
    output: round(lower, FINAL),
    legalRef: "s. 13, Inland Revenue Ordinance",
    note: usingStandard
      ? "The standard rate computation is lower, so it applies. At this income your personal allowances are worth nothing, because the standard rate ignores them."
      : "The progressive computation is lower, so it applies and your personal allowances are worth their full value.",
    unit: "money",
  });

  if (usingStandard) {
    warnings.push(
      "Your tax is set by the standard rate computation, which ignores personal allowances. Claiming another allowance would not reduce your bill at this income.",
    );
  }

  /* 10. One-off reduction, when the Budget grants one ------------------------ */
  const rebateSpec = rules.oneOffReduction;
  const rebate = rebateSpec
    ? min(round(tax.times(d(rebateSpec.percent)), R), d(rebateSpec.ceiling))
    : ZERO;
  trace.add({
    id: "hk-10",
    label: "One-off tax reduction",
    formula: rebateSpec
      ? `min(${pct(d(rebateSpec.percent))} x ${f(tax)}, ${f(d(rebateSpec.ceiling))})`
      : "0 - no one-off reduction was granted for this year of assessment",
    inputs: rebateSpec ? { "tax before reduction": tax, ceiling: d(rebateSpec.ceiling) } : {},
    output: rebate,
    note: rebateSpec
      ? undefined
      : "The 100% reduction capped at HKD 3,000 announced in the 2026-27 Budget applied to the year of assessment 2025/26, not to 2026/27.",
    unit: "money",
  });

  tax = trace.add({
    id: "hk-11",
    label: "Salaries tax payable",
    formula: `${f(tax)} - ${f(rebate)}`,
    inputs: { "tax before reduction": tax, "one-off reduction": rebate },
    output: floorZero(round(tax.minus(rebate), FINAL)),
    note: "The Inland Revenue Department rounds tax payable down to whole dollars.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "hk-12",
    label: "Balance to settle",
    formula: `${f(withheld)} (provisional tax paid) - ${f(tax)} (salaries tax payable)`,
    inputs: { "provisional tax paid": withheld, "salaries tax": tax },
    output: round(withheld.minus(tax), R),
    note: "Hong Kong has no PAYE withholding. Salaries tax is paid on assessment, usually in two instalments, together with provisional tax for the following year.",
    unit: "money",
  });

  return {
    trace,
    grossAssessed: income,
    social: mpfPaid,
    incomeTax: tax,
    withheld,
    months,
    warnings,
  };
}

export const hkAdapter: CountryAdapter = {
  country: "HK",
  currency: "HKD",
  label: "Hong Kong SAR",
  contributionLabel: "MPF contributions",
  regionLabel: "Territory",
  regionNote:
    "Salaries tax is territory-wide, so there is only one option. Hong Kong has no provincial or district income tax.",

  years: () => genericYears("HK"),
  regions: (year) => genericRegions("HK", year),

  fields(year): FieldSpec[] {
    return loadGeneric<HkRules>("HK", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<HkRules>("HK", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "HK",
      currency: "HKD",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("hk", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "In Hong Kong the marginal rate can FALL as income rises, at the point where the standard rate computation becomes the lower of the two.",
    });
  },
};
