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
import bg2026 from "../../rules/bg/2026/national.json";

registerGeneric("BG", 2026, bg2026);

interface BgRules extends GenericRuleset {
  flatRate: { legalRef: string; rate: string; note: string };
  socialInsurance: {
    legalRef: string;
    employeeSocialRate: string;
    employeeHealthRate: string;
    monthlyCaps: Array<{ months: number[]; cap: string }>;
    note: string;
  };
  childRelief: {
    legalRef: string;
    amounts: string[];
    disabledChild: string;
    note: string;
  };
}

const LOCALE = "bg-BG";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Bulgaria's pipeline. A single flat rate, but the order still matters: the 10%
 * is charged on gross pay LESS the mandatory contributions, and the child
 * relief reduces the BASE rather than the tax. The contribution ceiling is
 * monthly and it changed on 1 August 2026, so two months of identical pay on
 * either side of that date are capped differently - which is exactly why the
 * app collects twelve monthly figures rather than one annual one.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<BgRules>("BG", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Gross pay ------------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "bg-1",
    label: "Annual gross pay",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    note:
      months === 12
        ? undefined
        : `Only ${months} month(s) carry income. A partial year is taxed on the actual total; it is never annualised.`,
    unit: "money",
  });

  /* 2. Mandatory contributions, capped month by month ----------------------- */
  const si = rules.socialInsurance;
  const socialRate = d(si.employeeSocialRate);
  const healthRate = d(si.employeeHealthRate);
  const totalRate = socialRate.plus(healthRate);

  const capForMonth = (monthIndex: number): Decimal => {
    const entry = si.monthlyCaps.find((c) => c.months.includes(monthIndex + 1));
    if (!entry) throw new Error(`No insurance base cap defined for month ${monthIndex + 1}`);
    return d(entry.cap);
  };

  const monthlyBase = monthlyGross.map((g, i) => min(g, capForMonth(i)));
  const monthlyContribution = monthlyBase.map((b) => round(b.times(totalRate), R));
  const cappedMonths = monthlyGross.filter((g, i) => g.gt(capForMonth(i))).length;

  const contributions = trace.add({
    id: "bg-2",
    label: "Employee social and health insurance",
    formula: `sum over 12 months of ${pct(totalRate)} x min(monthly pay, monthly maximum base)`,
    inputs: {
      "social insurance rate": socialRate,
      "health insurance rate": healthRate,
      "combined employee rate": totalRate,
      "maximum base to 31 July": d(si.monthlyCaps[0].cap),
      "maximum base from 1 August": d(si.monthlyCaps[1].cap),
    },
    output: round(sum(monthlyContribution), R),
    legalRef: si.legalRef,
    note:
      cappedMonths > 0
        ? `${cappedMonths} month(s) exceeded the maximum monthly insurance base. The cap is monthly and it rose on 1 August 2026, so the same salary is capped differently across the year.`
        : si.note,
    unit: "money",
  });

  /* 3. Taxable base --------------------------------------------------------- */
  const voluntaryPension = readAnnual(v, "voluntaryPension");
  const baseBeforeRelief = floorZero(round(gross.minus(contributions), R));
  const voluntaryAllowed = min(voluntaryPension, round(baseBeforeRelief.times(d("0.10")), R));

  const taxableBase = trace.add({
    id: "bg-3",
    label: "Annual taxable base",
    formula: `${f(gross)} - ${f(contributions)} (mandatory contributions) - ${f(voluntaryAllowed)} (voluntary pension, max 10% of base)`,
    inputs: {
      gross,
      "mandatory contributions": contributions,
      "voluntary pension allowed": voluntaryAllowed,
    },
    output: floorZero(round(baseBeforeRelief.minus(voluntaryAllowed), R)),
    legalRef: "Art. 25, Personal Income Taxes Act",
    note: "Mandatory contributions are deductible in full. Bulgaria has no tax-free personal allowance, so everything left is taxed.",
    unit: "money",
  });

  /* 4. Child relief - reduces the base, not the tax -------------------------- */
  const cr = rules.childRelief;
  const children = readInt(v, "children");
  const disabled = Math.min(readInt(v, "disabledChildren"), children);
  const ordinary = children - disabled;
  const ordinaryRelief =
    ordinary === 0 ? ZERO : d(cr.amounts[Math.min(ordinary, cr.amounts.length) - 1]);
  const disabledRelief = d(cr.disabledChild).times(disabled);
  const reliefClaimed = min(ordinaryRelief.plus(disabledRelief), taxableBase);

  trace.add({
    id: "bg-4",
    label: "Child tax relief",
    formula:
      children === 0
        ? "0 - no children claimed"
        : `${f(ordinaryRelief)} (${ordinary} child(ren)) + ${f(disabledRelief)} (${disabled} child(ren) with a disability), limited to the taxable base`,
    inputs: {
      "ordinary child relief": ordinaryRelief,
      "disabled child relief": disabledRelief,
      "taxable base available": taxableBase,
    },
    output: reliefClaimed,
    legalRef: cr.legalRef,
    note: cr.note,
    unit: "money",
  });

  const finalBase = trace.add({
    id: "bg-5",
    label: "Taxable base after relief",
    formula: `${f(taxableBase)} - ${f(reliefClaimed)}`,
    inputs: { "taxable base": taxableBase, "child relief": reliefClaimed },
    output: floorZero(round(taxableBase.minus(reliefClaimed), R)),
    unit: "money",
  });

  /* 5. Flat tax -------------------------------------------------------------- */
  const rate = d(rules.flatRate.rate);
  const tax = trace.add({
    id: "bg-6",
    label: "Income tax",
    formula: `${pct(rate)} x ${f(finalBase)}`,
    inputs: { "taxable base after relief": finalBase, rate },
    output: round(finalBase.times(rate), R),
    legalRef: rules.flatRate.legalRef,
    note: rules.flatRate.note,
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "bg-7",
    label: "Refund or amount owing",
    formula: `${f(withheld)} (withheld) - ${f(tax)} (tax due)`,
    inputs: { withheld, "tax due": tax },
    output: round(withheld.minus(tax), R),
    note: "Child relief is usually claimed once a year through your employer or an annual return, so monthly withholding often exceeds the final liability for parents.",
    unit: "money",
  });

  if (children > 0) {
    warnings.push(
      "Only one parent may claim the child relief, and it is claimed annually. If your employer applied it monthly as well, do not count it twice.",
    );
  }

  return { trace, grossAssessed: gross, social: contributions, incomeTax: tax, withheld, months, warnings };
}

export const bgAdapter: CountryAdapter = {
  country: "BG",
  currency: "EUR",
  locale: LOCALE,
  label: "Bulgaria",
  contributionLabel: "Social and health insurance",
  regionLabel: "Jurisdiction",
  regionNote:
    "Bulgaria levies no regional or municipal income tax on employment income, so there is only one option.",

  years: () => genericYears("BG"),
  regions: (year) => genericRegions("BG", year),

  fields(year): FieldSpec[] {
    return loadGeneric<BgRules>("BG", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<BgRules>("BG", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "BG",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("bg", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "The flat 10% applies to pay after contributions, so the marginal rate is about 8.6% below the contribution ceiling and 10% above it.",
    });
  },
};
