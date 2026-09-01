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
import tr2026 from "../../rules/tr/2026/national.json";

registerGeneric("TR", 2026, tr2026);

interface TrRules extends GenericRuleset {
  brackets: ScaleSpec;
  sgk: {
    legalRef: string;
    employeeRate: string;
    unemploymentRate: string;
    monthlyCeiling: string;
    note: string;
  };
  minimumWageExemption: { legalRef: string; grossMonthlyMinimumWage: string; note: string };
}

const LOCALE = "tr-TR";
const f = (v: Decimal) => formatPlain(v, "TRY", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Turkey's pipeline. The distinctive step is the minimum wage exemption: the
 * income tax attributable to a minimum-wage salary is exempt for EVERY
 * employee, not only for those actually earning the minimum wage. It is
 * computed by running the same scale over a minimum-wage base and subtracting
 * the result, which means the relief is worth the same to a senior engineer as
 * to a shop assistant, and it is why Turkish net pay does not fall as sharply
 * at the bottom of the scale as the 15% entry rate suggests.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<TrRules>("TR", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "tr-1",
    label: "Yillik brut ucret",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* SGK, capped monthly ----------------------------------------------------------- */
  const sgkSpec = rules.sgk;
  const ceiling = d(sgkSpec.monthlyCeiling);
  const totalRate = d(sgkSpec.employeeRate).plus(d(sgkSpec.unemploymentRate));
  const monthlySgk = monthlyGross.map((g) => round(min(g, ceiling).times(totalRate), R));
  const sgk = trace.add({
    id: "tr-2",
    label: "SGK ve issizlik sigortasi primi",
    formula: `sum over 12 months of ${pct(totalRate)} x min(monthly pay, ${f(ceiling)})`,
    inputs: {
      "SGK orani": d(sgkSpec.employeeRate),
      "issizlik orani": d(sgkSpec.unemploymentRate),
      "aylik tavan": ceiling,
    },
    output: round(sum(monthlySgk), R),
    legalRef: sgkSpec.legalRef,
    note: sgkSpec.note,
    unit: "money",
  });

  /* Tax base ------------------------------------------------------------------------ */
  const base = trace.add({
    id: "tr-3",
    label: "Gelir vergisi matrahi",
    formula: `${f(gross)} - ${f(sgk)} (SGK)`,
    inputs: { "brut ucret": gross, SGK: sgk },
    output: floorZero(round(gross.minus(sgk), R)),
    legalRef: "GVK md. 63",
    unit: "money",
  });

  const scale = evaluateScale(base, rules.brackets, R);
  const beforeExemption = trace.add({
    id: "tr-4",
    label: "Hesaplanan gelir vergisi",
    formula: `tarife(${f(base)})`,
    inputs: { matrah: base },
    output: scale.total,
    legalRef: rules.brackets.legalRef,
    note: rules.brackets.note,
    bands: scale.rows,
    unit: "money",
  });

  /* Minimum wage exemption ---------------------------------------------------------- */
  const mw = rules.minimumWageExemption;
  const mwGrossMonth = d(mw.grossMonthlyMinimumWage);
  const mwBaseMonth = mwGrossMonth.minus(mwGrossMonth.times(totalRate));
  const mwBaseYear = round(mwBaseMonth.times(months), R);
  const mwTax = evaluateScale(mwBaseYear, rules.brackets, R).total;
  const exemption = min(mwTax, beforeExemption);

  trace.add({
    id: "tr-5",
    label: "Asgari ucret istisnasi",
    formula: `tarife(${f(mwBaseYear)}) = ${f(mwTax)} - the tax that would fall on a minimum wage of ${f(mwGrossMonth)} a month over ${months} month(s)`,
    inputs: {
      "asgari ucret brut (aylik)": mwGrossMonth,
      "istisna matrahi": mwBaseYear,
      "istisna tutari": exemption,
    },
    output: exemption,
    legalRef: mw.legalRef,
    note: mw.note,
    unit: "money",
  });

  const tax = trace.add({
    id: "tr-6",
    label: "Odenecek gelir vergisi",
    formula: `max(0, ${f(beforeExemption)} - ${f(exemption)})`,
    inputs: { hesaplanan: beforeExemption, istisna: exemption },
    output: floorZero(round(beforeExemption.minus(exemption), R)),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "tr-7",
    label: "Iade veya odenecek tutar",
    formula: `${f(withheld)} (kesilen) - ${f(tax)}`,
    inputs: { kesilen: withheld, odenecek: tax },
    output: round(withheld.minus(tax), R),
    unit: "money",
  });

  warnings.push(
    "Turkish withholding is cumulative through the year, so your net pay falls each time you cross a bracket. This figure is the annual liability, not the month-by-month deduction.",
  );

  return { trace, grossAssessed: gross, social: sgk, incomeTax: tax, withheld, months, warnings };
}

export const trAdapter: CountryAdapter = {
  country: "TR",
  currency: "TRY",
  locale: LOCALE,
  label: "Turkiye",
  contributionLabel: "SGK",
  regionLabel: "Jurisdiction",
  regionNote: "Turkish income tax has no regional component, so there is one option here.",

  years: () => genericYears("TR"),
  regions: (year) => genericRegions("TR", year),

  fields(year): FieldSpec[] {
    return loadGeneric<TrRules>("TR", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<TrRules>("TR", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "TR",
      currency: "TRY",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("tr", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "The minimum wage exemption is a fixed amount, so it does not change the marginal rate; it shifts the whole bill down.",
    });
  },
};
