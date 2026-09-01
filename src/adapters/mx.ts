import {
  Decimal,
  d,
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
import mx2026 from "../../rules/mx/2026/national.json";

registerGeneric("MX", 2026, mx2026);

interface MxRow {
  lowerLimit: string;
  fixedQuota: string;
  rate: string;
}

interface MxRules extends GenericRuleset {
  tariff: { legalRef: string; note: string; rows: MxRow[] };
}

const LOCALE = "es-MX";
const f = (v: Decimal) => formatPlain(v, "MXN", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Mexico's pipeline. The tariff is stated as a lower limit, a fixed quota and a
 * rate on the excess, and it is applied that way here because that is the form
 * in article 152 and the form a Mexican payslip shows. Arithmetically it is a
 * marginal scale, but a user checking this against their recibo will be looking
 * for the cuota fija.
 *
 * IMSS is deliberately NOT computed. It depends on several ramos de seguro
 * applied to a salario base de cotizacion that differs from gross pay, and
 * inventing a single rate would be worse than asking.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<MxRules>("MX", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "mx-1",
    label: "Ingreso anual acumulable",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  const imss = readAnnual(v, "imss");
  const imssStep = trace.add({
    id: "mx-2",
    label: "Cuotas IMSS",
    formula: imss.gt(0)
      ? "amount you entered"
      : "0 - not entered. IMSS depends on the salario base de cotizacion and several ramos de seguro, so this app does not guess at it",
    inputs: { "cuotas retenidas": imss },
    output: imss,
    legalRef: "Ley del Seguro Social",
    note: "Shown as a contribution. It reduces your take-home pay; it is not a deduction from the ISR base for an employee.",
    unit: "money",
  });

  /* The tariff --------------------------------------------------------------------- */
  const row = [...rules.tariff.rows].reverse().find((r) => gross.gte(d(r.lowerLimit)));
  const applied = row ?? rules.tariff.rows[0];
  const excess = floorZero(gross.minus(d(applied.lowerLimit)));
  const tax = trace.add({
    id: "mx-3",
    label: "ISR del ejercicio",
    formula: `${f(d(applied.fixedQuota))} (cuota fija) + ${pct(d(applied.rate))} x (${f(gross)} - ${f(d(applied.lowerLimit))})`,
    inputs: {
      "limite inferior": d(applied.lowerLimit),
      "cuota fija": d(applied.fixedQuota),
      "tasa sobre excedente": d(applied.rate),
      excedente: excess,
    },
    output: round(d(applied.fixedQuota).plus(excess.times(d(applied.rate))), R),
    legalRef: rules.tariff.legalRef,
    note: rules.tariff.note,
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "mx-4",
    label: "Saldo a favor o a cargo",
    formula: `${f(withheld)} (retenido) - ${f(tax)} (ISR)`,
    inputs: { retenido: withheld, ISR: tax },
    output: round(withheld.minus(tax), R),
    unit: "money",
  });

  warnings.push(
    "The subsidio para el empleo is not modelled. For a low salary it can remove the tax entirely, so this figure overstates what a low earner actually pays.",
  );

  return {
    trace,
    grossAssessed: gross,
    social: imssStep,
    incomeTax: tax,
    withheld,
    months,
    warnings,
  };
}

export const mxAdapter: CountryAdapter = {
  country: "MX",
  currency: "MXN",
  locale: LOCALE,
  label: "Mexico",
  contributionLabel: "IMSS",
  contributionNote: "Taken from what you enter, because it depends on your salario base de cotizacion.",
  regionLabel: "Jurisdiction",
  regionNote:
    "ISR on wages is federal. The states levy a payroll tax on employers rather than an income tax on employees, so there is one option here.",

  years: () => genericYears("MX"),
  regions: (year) => genericRegions("MX", year),

  fields(year): FieldSpec[] {
    return loadGeneric<MxRules>("MX", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<MxRules>("MX", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "MX",
      currency: "MXN",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("mx", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
    });
  },
};
