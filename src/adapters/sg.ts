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
import { readMonthly, readAnnual, readBool, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import sg2026 from "../../rules/sg/2026/national.json";

registerGeneric("SG", 2026, sg2026);

interface SgRules extends GenericRuleset {
  scale: ScaleSpec;
  cpf: {
    legalRef: string;
    employeeRate: string;
    monthlyOrdinaryWageCeiling: string;
    annualSalaryCeiling: string;
    note: string;
  };
  reliefs: {
    legalRef: string;
    earnedIncomeRelief: string;
    totalReliefCap: string;
    note: string;
  };
}

const f = (v: Decimal) => formatPlain(v, "SGD");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Singapore's pipeline. The distinctive step is the SGD 80,000 cap on TOTAL
 * personal reliefs: CPF relief, earned income relief and everything else are
 * added together and then truncated as a group. A high earner with large
 * reliefs therefore gets no benefit from the last of them, which a per-relief
 * cap model would miss. Donations sit outside the cap, and are deducted at
 * 250% of the amount given rather than at face value.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<SgRules>("SG", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Employment income ---------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const income = trace.add({
    id: "sg-1",
    label: "Employment income",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. CPF, capped monthly then again annually ------------------------------ */
  const cpf = rules.cpf;
  const isMember = v["citizen"] === undefined ? true : readBool(v, "citizen");
  const owCeiling = d(cpf.monthlyOrdinaryWageCeiling);
  const rate = d(cpf.employeeRate);
  const annualWageCeiling = d(cpf.annualSalaryCeiling);

  let cumulativeWages = ZERO;
  const monthlyCpf = monthlyGross.map((g) => {
    if (!isMember) return ZERO;
    const remainingAnnual = floorZero(annualWageCeiling.minus(cumulativeWages));
    const base = min(min(g, owCeiling), remainingAnnual);
    cumulativeWages = cumulativeWages.plus(min(g, owCeiling));
    return round(base.times(rate), R);
  });
  const cpfTotal = round(sum(monthlyCpf), R);

  trace.add({
    id: "sg-2",
    label: "CPF contributions (employee share)",
    formula: isMember
      ? `sum over 12 months of ${pct(rate)} x min(monthly wage, ${f(owCeiling)}), stopping at the annual salary ceiling of ${f(annualWageCeiling)}`
      : "0 - foreign employees on work passes do not contribute to CPF",
    inputs: {
      "employee rate": rate,
      "monthly Ordinary Wage ceiling": owCeiling,
      "annual salary ceiling": annualWageCeiling,
    },
    output: cpfTotal,
    legalRef: cpf.legalRef,
    note: cpf.note,
    unit: "money",
  });

  /* 3. Reliefs, then the single overall cap ---------------------------------- */
  const r = rules.reliefs;
  const earnedIncome = min(d(r.earnedIncomeRelief), income);
  const other = readAnnual(v, "otherReliefs");
  const reliefsClaimed = sum([cpfTotal, earnedIncome, other]);
  const cap = d(r.totalReliefCap);
  const reliefsAllowed = min(reliefsClaimed, cap);

  const reliefs = trace.add({
    id: "sg-3",
    label: "Personal reliefs",
    formula: `min(${f(cpfTotal)} (CPF) + ${f(earnedIncome)} (earned income) + ${f(other)} (other), cap of ${f(cap)})`,
    inputs: {
      "CPF relief": cpfTotal,
      "earned income relief": earnedIncome,
      "other reliefs": other,
      "claimed in total": reliefsClaimed,
      "overall cap": cap,
    },
    output: round(reliefsAllowed, R),
    legalRef: r.legalRef,
    note: r.note,
    unit: "money",
  });

  if (reliefsClaimed.gt(cap)) {
    warnings.push(
      `Your reliefs total ${f(reliefsClaimed)}, above the ${f(cap)} overall cap, so ${f(reliefsClaimed.minus(cap))} of them is worth nothing. Claiming another relief would not reduce your tax.`,
    );
  }

  /* 4. Donations sit outside the cap, at 250% -------------------------------- */
  const donationsGiven = readAnnual(v, "donations");
  const donationDeduction = round(donationsGiven.times(d("2.5")), R);
  trace.add({
    id: "sg-4",
    label: "Approved donations",
    formula: donationsGiven.gt(0)
      ? `2.5 x ${f(donationsGiven)} - deducted outside the relief cap`
      : "0 - no qualifying donations entered",
    inputs: { "amount given": donationsGiven },
    output: donationDeduction,
    legalRef: "s. 37(3) Income Tax Act 1947",
    note: "Qualifying donations to an approved Institution of a Public Character are deducted at 250% of the amount given, and are not counted against the SGD 80,000 relief cap.",
    unit: "money",
  });

  /* 5. Chargeable income ------------------------------------------------------ */
  const chargeable = trace.add({
    id: "sg-5",
    label: "Chargeable income",
    formula: `max(0, ${f(income)} - ${f(reliefs)} - ${f(donationDeduction)})`,
    inputs: { income, reliefs, donations: donationDeduction },
    output: floorZero(round(income.minus(reliefs).minus(donationDeduction), R)),
    unit: "money",
  });

  /* 6. The rate table --------------------------------------------------------- */
  const scale = evaluateScale(chargeable, rules.scale, R);
  const tax = trace.add({
    id: "sg-6",
    label: "Income tax",
    formula: `resident_rates(${f(chargeable)})`,
    inputs: { "chargeable income": chargeable },
    output: scale.total,
    legalRef: rules.scale.legalRef,
    note: rules.scale.note,
    bands: scale.rows,
    unit: "money",
  });

  trace.add({
    id: "sg-7",
    label: "Net pay",
    formula: `${f(income)} - ${f(cpfTotal)} (CPF) - ${f(tax)} (tax)`,
    inputs: { income, CPF: cpfTotal, tax },
    output: round(income.minus(cpfTotal).minus(tax), R),
    note: "Singapore has no withholding for residents. Tax is assessed after the year ends and paid in instalments, so plan for it.",
    unit: "money",
  });

  return { trace, grossAssessed: income, social: cpfTotal, incomeTax: tax, withheld: ZERO, months, warnings };
}

export const sgAdapter: CountryAdapter = {
  country: "SG",
  currency: "SGD",
  label: "Singapore",
  contributionLabel: "CPF contributions",
  regionLabel: "Jurisdiction",
  regionNote: "Singapore has no state or municipal income tax, so there is only one option.",

  years: () => genericYears("SG"),
  regions: (year) => genericRegions("SG", year),

  fields(year): FieldSpec[] {
    return loadGeneric<SgRules>("SG", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<SgRules>("SG", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "SG",
      currency: "SGD",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("sg", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "CPF reduces chargeable income, so below the wage ceilings each extra dollar of pay raises taxable income by only 80 cents.",
    });
  },
};
