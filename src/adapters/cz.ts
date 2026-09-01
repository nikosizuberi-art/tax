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
import { readMonthly, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import cz2026 from "../../rules/cz/2026/national.json";

registerGeneric("CZ", 2026, cz2026);

interface CzRules extends GenericRuleset {
  scale: {
    legalRef: string;
    threshold: string;
    lowerRate: string;
    upperRate: string;
    note: string;
  };
  taxpayerCredit: { legalRef: string; amount: string; note: string };
  socialInsurance: {
    legalRef: string;
    socialRate: string;
    socialAnnualCap: string;
    healthRate: string;
    note: string;
  };
  rounding: GenericRuleset["rounding"] & { taxBaseDp: number };
}

const LOCALE = "cs-CZ";
const f = (v: Decimal) => formatPlain(v, "CZK", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * The Czech pipeline. Contributions are NOT deductible from the income tax
 * base - tax is charged on gross salary - so the two computations run over the
 * same figure independently. The tax-free effect at the bottom comes entirely
 * from a credit against the tax, and social security stops at an annual cap
 * that bites part-way through a high earner's year while health insurance
 * carries on.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<CzRules>("CZ", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };
  const BASE: Rounding = { dp: rules.rounding.taxBaseDp, mode: "down" };

  /* 1. Hruba mzda -------------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "cz-1",
    label: "Hruba mzda za rok",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. Pojistne ---------------------------------------------------------------- */
  const si = rules.socialInsurance;
  const cap = d(si.socialAnnualCap);
  const socialBase = min(gross, cap);
  const social = round(socialBase.times(d(si.socialRate)), R);
  const health = round(gross.times(d(si.healthRate)), R);

  const contributions = trace.add({
    id: "cz-2",
    label: "Socialni a zdravotni pojisteni",
    formula: `${pct(d(si.socialRate))} x min(${f(gross)}, ${f(cap)}) = ${f(social)} + ${pct(d(si.healthRate))} x ${f(gross)} = ${f(health)}`,
    inputs: { "socialni pojisteni": social, "zdravotni pojisteni": health, "rocni strop": cap },
    output: round(social.plus(health), R),
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* 3. Zaklad dane - gross salary, contributions not deducted ------------------ */
  const base = trace.add({
    id: "cz-3",
    label: "Zaklad dane",
    formula: `${f(gross)} - 0 (contributions are not deductible in the Czech Republic)`,
    inputs: { "hruba mzda": gross },
    output: round(gross, BASE),
    legalRef: "§ 6 zakona o danich z prijmu",
    note: "Unlike most of Europe, the Czech base is gross salary. Your social and health contributions do not reduce it.",
    unit: "money",
  });

  /* 4. Dan pred slevou ---------------------------------------------------------- */
  const threshold = d(rules.scale.threshold);
  const lower = min(base, threshold);
  const upper = floorZero(base.minus(threshold));
  const grossTax = round(
    lower.times(d(rules.scale.lowerRate)).plus(upper.times(d(rules.scale.upperRate))),
    R,
  );

  const before = trace.add({
    id: "cz-4",
    label: "Dan pred slevami",
    formula: `${pct(d(rules.scale.lowerRate))} x ${f(lower)} + ${pct(d(rules.scale.upperRate))} x ${f(upper)}`,
    inputs: { "do prahu": lower, "nad prah": upper, prah: threshold },
    output: grossTax,
    legalRef: rules.scale.legalRef,
    note: rules.scale.note,
    unit: "money",
  });

  /* 5. Sleva na poplatnika ------------------------------------------------------ */
  const credit = min(d(rules.taxpayerCredit.amount), before);
  trace.add({
    id: "cz-5",
    label: "Sleva na poplatnika",
    formula: `${f(d(rules.taxpayerCredit.amount))}, limited to the tax due`,
    inputs: { sleva: d(rules.taxpayerCredit.amount), uplatneno: credit },
    output: credit,
    legalRef: rules.taxpayerCredit.legalRef,
    note: rules.taxpayerCredit.note,
    unit: "money",
  });

  const tax = trace.add({
    id: "cz-6",
    label: "Dan po slevach",
    formula: `max(0, ${f(before)} - ${f(credit)})`,
    inputs: { "pred slevami": before, sleva: credit },
    output: floorZero(round(before.minus(credit), R)),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "cz-7",
    label: "Preplatek nebo nedoplatek",
    formula: `${f(withheld)} (zalohy) - ${f(tax)} (dan)`,
    inputs: { zalohy: withheld, dan: tax },
    output: round(withheld.minus(tax), R),
    unit: "money",
  });

  if (gross.gt(cap)) {
    warnings.push(
      "Your pay passed the annual social security cap, so social contributions stopped for the rest of the year. Health insurance continued, because it has no cap.",
    );
  }

  return { trace, grossAssessed: gross, social: contributions, incomeTax: tax, withheld, months, warnings };
}

export const czAdapter: CountryAdapter = {
  country: "CZ",
  currency: "CZK",
  locale: LOCALE,
  label: "Czech Republic",
  contributionLabel: "Pojistne",
  contributionNote: "Social security and health insurance, neither deductible from the tax base.",
  regionLabel: "Jurisdiction",
  regionNote: "Czech income tax has no regional component, so there is one option here.",

  years: () => genericYears("CZ"),
  regions: (year) => genericRegions("CZ", year),

  fields(year): FieldSpec[] {
    return loadGeneric<CzRules>("CZ", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<CzRules>("CZ", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "CZ",
      currency: "CZK",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("cz", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
    });
  },
};
