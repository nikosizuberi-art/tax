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
import at2026 from "../../rules/at/2026/national.json";

registerGeneric("AT", 2026, at2026);

interface AtRules extends GenericRuleset {
  brackets: ScaleSpec;
  specialPayments: { legalRef: string; exemptAmount: string; rate: string; note: string };
  socialSecurity: {
    legalRef: string;
    employeeRate: string;
    monthlyCeiling: string;
    note: string;
  };
  deductions: { werbungskostenPauschale: string; verkehrsabsetzbetrag: string; note: string };
}

const LOCALE = "de-AT";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Austria's pipeline has TWO income streams that never meet. The twelve
 * ordinary salaries run through the progressive scale; the 13th and 14th
 * payments are taxed at a flat 6% after a EUR 620 exemption, under § 67, and
 * never enter the progression at all.
 *
 * That is not a bracket variation, it is a second tax base, and it is why an
 * Austrian on the same annual gross as a German pays noticeably less.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<AtRules>("AT", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Laufende Bezuege ------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const regular = trace.add({
    id: "at-1",
    label: "Laufende Bezuege (ordinary salary)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  const special = readAnnual(v, "specialPayments");
  trace.add({
    id: "at-2",
    label: "Sonstige Bezuege (13th and 14th salary)",
    formula: special.gt(0) ? "amount entered" : "0 - no special payments entered",
    inputs: { "sonstige Bezuege": special },
    output: special,
    legalRef: rules.specialPayments.legalRef,
    note: rules.specialPayments.note,
    unit: "money",
  });

  /* 2. Sozialversicherung on both streams ------------------------------------- */
  const si = rules.socialSecurity;
  const ceiling = d(si.monthlyCeiling);
  const rate = d(si.employeeRate);
  const svRegular = round(sum(monthlyGross.map((g) => min(g, ceiling).times(rate))), R);
  const svSpecial = round(special.times(rate), R);

  const socialTotal = trace.add({
    id: "at-3",
    label: "Sozialversicherung (employee share)",
    formula: `${pct(rate)} x min(monthly pay, ${f(ceiling)}) = ${f(svRegular)}; on special payments ${pct(rate)} x ${f(special)} = ${f(svSpecial)}`,
    inputs: {
      "auf laufende Bezuege": svRegular,
      "auf sonstige Bezuege": svSpecial,
      "monatliche Hoechstbeitragsgrundlage": ceiling,
    },
    output: round(svRegular.plus(svSpecial), R),
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* 3. Steuerbemessungsgrundlage for the ordinary stream ---------------------- */
  const pauschale = d(rules.deductions.werbungskostenPauschale);
  const taxable = trace.add({
    id: "at-4",
    label: "Steuerbemessungsgrundlage (laufende Bezuege)",
    formula: `${f(regular)} - ${f(svRegular)} (SV) - ${f(pauschale)} (Werbungskostenpauschale)`,
    inputs: { "laufende Bezuege": regular, SV: svRegular, Werbungskostenpauschale: pauschale },
    output: floorZero(round(regular.minus(svRegular).minus(pauschale), R)),
    legalRef: "§ 16 EStG 1988",
    unit: "money",
  });

  /* 4. Tarif ------------------------------------------------------------------- */
  const scale = evaluateScale(taxable, rules.brackets, R);
  const tarifTax = trace.add({
    id: "at-5",
    label: "Einkommensteuer nach Tarif",
    formula: `tarif(${f(taxable)})`,
    inputs: { Bemessungsgrundlage: taxable },
    output: scale.total,
    legalRef: rules.brackets.legalRef,
    note: rules.brackets.note,
    bands: scale.rows,
    unit: "money",
  });

  const vab = min(d(rules.deductions.verkehrsabsetzbetrag), tarifTax);
  trace.add({
    id: "at-6",
    label: "Verkehrsabsetzbetrag",
    formula: `${f(d(rules.deductions.verkehrsabsetzbetrag))}, limited to the tax due`,
    inputs: { Absetzbetrag: d(rules.deductions.verkehrsabsetzbetrag), angerechnet: vab },
    output: vab,
    legalRef: "§ 33 Abs. 5 EStG 1988",
    note: rules.deductions.note,
    unit: "money",
  });

  const regularTax = floorZero(round(tarifTax.minus(vab), R));

  /* 5. The 6% stream ----------------------------------------------------------- */
  const sp = rules.specialPayments;
  const specialBase = floorZero(round(special.minus(svSpecial).minus(d(sp.exemptAmount)), R));
  const specialTax = trace.add({
    id: "at-7",
    label: "Steuer auf sonstige Bezuege",
    formula: special.gt(0)
      ? `${pct(d(sp.rate))} x (${f(special)} - ${f(svSpecial)} (SV) - ${f(d(sp.exemptAmount))} (Freibetrag))`
      : "0 - no special payments entered",
    inputs: {
      "sonstige Bezuege": special,
      "SV darauf": svSpecial,
      Freibetrag: d(sp.exemptAmount),
      Bemessungsgrundlage: specialBase,
    },
    output: round(specialBase.times(d(sp.rate)), R),
    legalRef: sp.legalRef,
    note: sp.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "at-8",
    label: "Einkommensteuer insgesamt",
    formula: `${f(regularTax)} (laufende Bezuege) + ${f(specialTax)} (sonstige Bezuege)`,
    inputs: { "auf laufende Bezuege": regularTax, "auf sonstige Bezuege": specialTax },
    output: round(regularTax.plus(specialTax), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "at-9",
    label: "Gutschrift oder Nachzahlung",
    formula: `${f(withheld)} (Lohnsteuer) - ${f(totalTax)}`,
    inputs: { einbehalten: withheld, geschuldet: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (special.gt(0)) {
    warnings.push(
      "Your 13th and 14th salary were taxed at 6% rather than at your marginal rate. That relief is limited to the Jahressechstel, which this app does not check, so a very large bonus is undertaxed here.",
    );
  }

  return {
    trace,
    grossAssessed: round(regular.plus(special), R),
    social: socialTotal,
    incomeTax: totalTax,
    withheld,
    months,
    warnings,
  };
}

export const atAdapter: CountryAdapter = {
  country: "AT",
  currency: "EUR",
  locale: LOCALE,
  label: "Austria",
  contributionLabel: "Sozialversicherung",
  regionLabel: "Jurisdiction",
  regionNote: "Austrian income tax has no regional component, so there is one option here.",

  years: () => genericYears("AT"),
  regions: (year) => genericRegions("AT", year),

  fields(year): FieldSpec[] {
    return loadGeneric<AtRules>("AT", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<AtRules>("AT", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "AT",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("at", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "This measures the rate on ordinary salary. An extra euro of 13th or 14th salary is taxed at 6% instead.",
    });
  },
};
