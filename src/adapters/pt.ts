import {
  Decimal,
  d,
  ZERO,
  min,
  max,
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
import pt2026 from "../../rules/pt/2026/national.json";

registerGeneric("PT", 2026, pt2026);

interface PtBand {
  upTo: string | null;
  rate: string;
  deduct: string;
}

interface PtRules extends GenericRuleset {
  scale: { legalRef: string; note: string; bands: PtBand[] };
  specificDeduction: { legalRef: string; floor: string; note: string };
  socialSecurity: { legalRef: string; employeeRate: string; note: string };
  solidarity: ScaleSpec;
}

const LOCALE = "pt-PT";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Portugal's pipeline. The statute does not express the scale as marginal
 * bands: it gives a rate for the whole income and a parcela a abater, a fixed
 * amount subtracted afterwards. The two are arithmetically equivalent, but this
 * adapter computes it the statutory way because that is what appears on a
 * Portuguese assessment and it is what a user will be checking against.
 *
 * The specific deduction is also unusual: it is the HIGHER of a fixed floor and
 * your actual social security, so for most employees the contributions are
 * effectively not deducted at all.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<PtRules>("PT", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Remuneracao bruta ------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "pt-1",
    label: "Rendimento bruto anual",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. Seguranca social -------------------------------------------------------- */
  const ss = trace.add({
    id: "pt-2",
    label: "Contribuicoes para a Seguranca Social",
    formula: `${pct(d(rules.socialSecurity.employeeRate))} x ${f(gross)}`,
    inputs: { taxa: d(rules.socialSecurity.employeeRate) },
    output: round(gross.times(d(rules.socialSecurity.employeeRate)), R),
    legalRef: rules.socialSecurity.legalRef,
    note: rules.socialSecurity.note,
    unit: "money",
  });

  /* 3. Deducao especifica ------------------------------------------------------ */
  const floor = d(rules.specificDeduction.floor);
  const specific = min(max(ss, floor), gross);
  const taxable = trace.add({
    id: "pt-3",
    label: "Rendimento coletavel",
    formula: `${f(gross)} - max(${f(ss)} (seguranca social), ${f(floor)} (deducao minima)) = ${f(gross)} - ${f(specific)}`,
    inputs: { bruto: gross, "seguranca social": ss, "deducao minima": floor, "deducao aplicada": specific },
    output: floorZero(round(gross.minus(specific), R)),
    legalRef: rules.specificDeduction.legalRef,
    note: rules.specificDeduction.note,
    unit: "money",
  });

  /* 4. Colecta, the statutory way ---------------------------------------------- */
  const band =
    rules.scale.bands.find((b) => b.upTo === null || taxable.lte(d(b.upTo))) ??
    rules.scale.bands[rules.scale.bands.length - 1];
  const colecta = floorZero(round(taxable.times(d(band.rate)).minus(d(band.deduct)), R));

  const colectaStep = trace.add({
    id: "pt-4",
    label: "Colecta",
    formula: `${pct(d(band.rate))} x ${f(taxable)} - ${f(d(band.deduct))} (parcela a abater)`,
    inputs: {
      "rendimento coletavel": taxable,
      taxa: d(band.rate),
      "parcela a abater": d(band.deduct),
    },
    output: colecta,
    legalRef: rules.scale.legalRef,
    note: rules.scale.note,
    unit: "money",
  });

  /* 5. Deducoes a coleta -------------------------------------------------------- */
  const ppr = readAnnual(v, "ppr");
  const pprCredit = min(min(round(ppr.times(d("0.20")), R), d("400")), colectaStep);
  trace.add({
    id: "pt-5",
    label: "Deducao a coleta - PPR",
    formula: ppr.gt(0)
      ? `min(20% x ${f(ppr)}, ${f(d("400"))})`
      : "0 - sem contribuicoes para PPR",
    inputs: { "contribuicoes PPR": ppr, "deducao aplicada": pprCredit },
    output: pprCredit,
    legalRef: "Art. 21 EBF",
    note: "Retirement savings give a credit against the tax, not a deduction from income, and the credit is capped.",
    unit: "money",
  });

  const afterCredits = floorZero(round(colectaStep.minus(pprCredit), R));

  /* 6. Taxa adicional de solidariedade ------------------------------------------ */
  const solidarityScale = evaluateScale(taxable, rules.solidarity, R);
  const solidarity = trace.add({
    id: "pt-6",
    label: "Taxa adicional de solidariedade",
    formula: solidarityScale.total.gt(0)
      ? `solidariedade(${f(taxable)})`
      : "0 - rendimento abaixo de 80.000 EUR",
    inputs: { "rendimento coletavel": taxable },
    output: solidarityScale.total,
    legalRef: rules.solidarity.legalRef,
    note: rules.solidarity.note,
    bands: solidarityScale.rows,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "pt-7",
    label: "IRS a pagar",
    formula: `${f(afterCredits)} (colecta liquida) + ${f(solidarity)} (solidariedade)`,
    inputs: { "colecta liquida": afterCredits, solidariedade: solidarity },
    output: round(afterCredits.plus(solidarity), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "pt-8",
    label: "Reembolso ou pagamento",
    formula: `${f(withheld)} (retencoes) - ${f(totalTax)} (IRS)`,
    inputs: { retencoes: withheld, IRS: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  warnings.push(
    "The minimo de existencia, which removes tax entirely at low incomes, is not modelled, so a low income is overstated here.",
  );

  return { trace, grossAssessed: gross, social: ss, incomeTax: totalTax, withheld, months, warnings };
}

export const ptAdapter: CountryAdapter = {
  country: "PT",
  currency: "EUR",
  locale: LOCALE,
  label: "Portugal",
  contributionLabel: "Seguranca Social",
  regionLabel: "Territorio",
  regionNote:
    "Mainland Portugal only. The Azores and Madeira apply reduced rates that this version does not model.",

  years: () => genericYears("PT"),
  regions: (year) => genericRegions("PT", year),

  fields(year): FieldSpec[] {
    return loadGeneric<PtRules>("PT", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<PtRules>("PT", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "PT",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("pt", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Because the statute changes both the rate and the parcela a abater at each threshold, the marginal rate at a band edge is not simply the new band rate.",
    });
  },
};
