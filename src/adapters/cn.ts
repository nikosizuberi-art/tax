import {
  Decimal,
  d,
  min,
  sum,
  floorZero,
  round,
  formatPlain,
  type Rounding,
} from "../engine/money";
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
import cn2026 from "../../rules/cn/2026/national.json";

registerGeneric("CN", 2026, cn2026);

interface CnRules extends GenericRuleset {
  basicDeduction: { legalRef: string; amount: string; note: string };
  brackets: {
    legalRef: string;
    note: string;
    bands: Array<{ upTo: string | null; rate: string; deduct: string }>;
  };
}

const LOCALE = "zh-CN";
const f = (v: Decimal) => formatPlain(v, "CNY", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * China's pipeline. The rate table is published as a rate plus a quick
 * deduction and that is how it is applied here, because it is what a Chinese
 * payroll system prints and what a user will be checking against.
 *
 * The mechanism this app deliberately does NOT reproduce is cumulative
 * withholding: China withholds against cumulative income to date, so a worker
 * on an unchanging salary sees their net pay fall step by step through the
 * year. The annual liability computed here is the figure that reconciliation
 * settles to.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<CnRules>("CN", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "cn-1",
    label: "Annual comprehensive income",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  const socialPaid = readAnnual(v, "socialInsurance");
  const social = trace.add({
    id: "cn-2",
    label: "Social insurance and housing fund",
    formula: socialPaid.gt(0)
      ? "amount you entered"
      : "0 - not entered. Rates and bases are set city by city, so this app cannot compute them",
    inputs: { "amount entered": socialPaid },
    output: socialPaid,
    legalRef: "Social Insurance Law of the PRC",
    note: "Deductible in full from comprehensive income. Because the rates differ in every city, this is the one figure the app asks you to take from your payslip.",
    unit: "money",
  });

  const basic = d(rules.basicDeduction.amount);
  const special = readAnnual(v, "specialDeductions");

  const taxable = trace.add({
    id: "cn-3",
    label: "Annual taxable income",
    formula: `${f(gross)} - ${f(basic)} (basic deduction) - ${f(social)} (social insurance) - ${f(special)} (special additional deductions)`,
    inputs: {
      "comprehensive income": gross,
      "basic deduction": basic,
      "social insurance": social,
      "special additional deductions": special,
    },
    output: floorZero(round(gross.minus(basic).minus(social).minus(special), R)),
    legalRef: rules.basicDeduction.legalRef,
    note: rules.basicDeduction.note,
    unit: "money",
  });

  const band =
    rules.brackets.bands.find((b) => b.upTo === null || taxable.lte(d(b.upTo))) ??
    rules.brackets.bands[rules.brackets.bands.length - 1];
  const tax = trace.add({
    id: "cn-4",
    label: "Individual income tax",
    formula: `${pct(d(band.rate))} x ${f(taxable)} - ${f(d(band.deduct))} (quick deduction)`,
    inputs: { "taxable income": taxable, rate: d(band.rate), "quick deduction": d(band.deduct) },
    output: floorZero(round(taxable.times(d(band.rate)).minus(d(band.deduct)), R)),
    legalRef: rules.brackets.legalRef,
    note: rules.brackets.note,
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "cn-5",
    label: "Annual reconciliation",
    formula: `${f(withheld)} (withheld) - ${f(tax)}`,
    inputs: { withheld, tax },
    output: round(withheld.minus(tax), R),
    note: "Because withholding is cumulative, the monthly amounts vary through the year even on a flat salary. The reconciliation settles the difference.",
    unit: "money",
  });

  if (socialPaid.isZero() && gross.gt(0)) {
    warnings.push(
      "No social insurance or housing fund was entered. Those contributions are deductible and typically reduce Chinese taxable income by a tenth or more, so this figure overstates the tax.",
    );
  }

  return { trace, grossAssessed: gross, social, incomeTax: tax, withheld, months, warnings };
}

export const cnAdapter: CountryAdapter = {
  country: "CN",
  currency: "CNY",
  locale: LOCALE,
  label: "China",
  contributionLabel: "Social insurance",
  contributionNote: "City-specific, so taken from what you enter rather than computed.",
  regionLabel: "Jurisdiction",
  regionNote:
    "Income tax rates are national. Social insurance and the housing fund vary by city, which is why this app asks you for that figure instead of computing it.",

  years: () => genericYears("CN"),
  regions: (year) => genericRegions("CN", year),

  fields(year): FieldSpec[] {
    return loadGeneric<CnRules>("CN", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<CnRules>("CN", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "CN",
      currency: "CNY",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("cn", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
    });
  },
};
