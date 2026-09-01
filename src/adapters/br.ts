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
import br2026 from "../../rules/br/2026/national.json";

registerGeneric("BR", 2026, br2026);

interface BrBand {
  upTo: string | null;
  rate: string;
  deduct: string;
}

interface BrRules extends GenericRuleset {
  inss: { legalRef: string; note: string; ceiling: string; bands: BrBand[] };
  irrfMonthly: { legalRef: string; note: string; bands: BrBand[] };
  simplifiedDiscount: { legalRef: string; monthlyAmount: string; note: string };
  reformaDaRenda: {
    legalRef: string;
    fullExemptionMonthly: string;
    phaseOutCeiling: string;
    redutorBase: string;
    redutorRate: string;
    note: string;
  };
}

const LOCALE = "pt-BR";
const f = (v: Decimal) => formatPlain(v, "BRL", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Brazil is the one country here whose tax genuinely IS twelve separate
 * computations. INSS and IRRF are both applied to each month on monthly tables,
 * and the 2026 reforma da renda exemption is tested month by month against
 * monthly pay - so the same annual salary produces a different tax depending on
 * how it was spread across the year. Summing to an annual figure first, then
 * taxing it, would give the wrong answer.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<BrRules>("BR", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "br-1",
    label: "Salario bruto anual",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* INSS, month by month --------------------------------------------------------- */
  const inssCeiling = d(rules.inss.ceiling);
  const inssFor = (pay: Decimal): Decimal => {
    if (pay.lte(0)) return ZERO;
    const capped = min(pay, inssCeiling);
    const band =
      rules.inss.bands.find((b) => b.upTo === null || capped.lte(d(b.upTo))) ??
      rules.inss.bands[rules.inss.bands.length - 1];
    return round(capped.times(d(band.rate)).minus(d(band.deduct)), R);
  };
  const monthlyInss = monthlyGross.map(inssFor);
  const cappedMonths = monthlyGross.filter((g) => g.gt(inssCeiling)).length;

  const inss = trace.add({
    id: "br-2",
    label: "Contribuicao ao INSS",
    formula: `for each month: rate x min(salario, ${f(inssCeiling)}) - parcela a deduzir, summed over the year`,
    inputs: {
      teto: inssCeiling,
      "contribuicao maxima mensal": inssFor(inssCeiling),
    },
    output: round(sum(monthlyInss), R),
    legalRef: rules.inss.legalRef,
    note:
      cappedMonths > 0
        ? `${cappedMonths} month(s) exceeded the INSS ceiling, so the contribution stopped at ${f(inssFor(inssCeiling))} in those months.`
        : rules.inss.note,
    unit: "money",
  });

  /* IRRF, month by month ---------------------------------------------------------- */
  const discount = d(rules.simplifiedDiscount.monthlyAmount);
  const rr = rules.reformaDaRenda;
  const exemption = d(rr.fullExemptionMonthly);
  const ceiling = d(rr.phaseOutCeiling);

  let exemptMonths = 0;
  let redutorMonths = 0;

  const monthlyIrrf = monthlyGross.map((pay, i) => {
    if (pay.lte(0)) return ZERO;
    if (pay.lte(exemption)) {
      exemptMonths += 1;
      return ZERO;
    }
    // The simplified discount replaces the legal deductions, so take whichever
    // is larger: the actual INSS or the flat monthly discount.
    const base = floorZero(pay.minus(max(monthlyInss[i], discount)));
    const band =
      rules.irrfMonthly.bands.find((b) => b.upTo === null || base.lte(d(b.upTo))) ??
      rules.irrfMonthly.bands[rules.irrfMonthly.bands.length - 1];
    let tax = floorZero(round(base.times(d(band.rate)).minus(d(band.deduct)), R));

    if (pay.lte(ceiling)) {
      const redutor = floorZero(round(d(rr.redutorBase).minus(pay.times(d(rr.redutorRate))), R));
      if (redutor.gt(0)) redutorMonths += 1;
      tax = floorZero(round(tax.minus(redutor), R));
    }
    return tax;
  });

  const irrf = trace.add({
    id: "br-3",
    label: "IRRF retido na fonte",
    formula: `for each month: table(salario - max(INSS, ${f(discount)} desconto simplificado)), then the redutor for pay up to ${f(ceiling)}`,
    inputs: {
      "desconto simplificado mensal": discount,
      "isencao mensal": exemption,
      "teto do redutor": ceiling,
      "meses isentos": new Decimal(exemptMonths),
      "meses com redutor": new Decimal(redutorMonths),
    },
    output: round(sum(monthlyIrrf), R),
    legalRef: rules.irrfMonthly.legalRef,
    note: rules.irrfMonthly.note,
    unit: "money",
  });

  trace.add({
    id: "br-4",
    label: "Reforma da Renda 2026",
    formula: `pay up to ${f(exemption)} a month is exempt; between ${f(exemption)} and ${f(ceiling)} the redutor is ${f(d(rr.redutorBase))} - ${pct(d(rr.redutorRate))} x salario`,
    inputs: {
      "isencao total ate": exemption,
      "reducao ate": ceiling,
      "meses isentos": new Decimal(exemptMonths),
    },
    output: new Decimal(exemptMonths),
    legalRef: rr.legalRef,
    note: rr.note,
    unit: "count",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "br-5",
    label: "Restituicao ou imposto a pagar",
    formula: `${f(withheld)} (retido) - ${f(irrf)} (devido)`,
    inputs: { retido: withheld, devido: irrf },
    output: round(withheld.minus(irrf), R),
    unit: "money",
  });

  if (exemptMonths > 0 && exemptMonths < months) {
    warnings.push(
      `${exemptMonths} of your ${months} paid months fell within the R$ 5.000 exemption and ${months - exemptMonths} did not. Because Brazil tests the exemption monthly, spreading the same annual pay more evenly would change your tax.`,
    );
  }

  return { trace, grossAssessed: gross, social: inss, incomeTax: irrf, withheld, months, warnings };
}

export const brAdapter: CountryAdapter = {
  country: "BR",
  currency: "BRL",
  locale: LOCALE,
  label: "Brazil",
  contributionLabel: "INSS",
  regionLabel: "Jurisdiction",
  regionNote:
    "Brazilian income tax on wages has no state or municipal component, so there is one option here.",

  years: () => genericYears("BR"),
  regions: (year) => genericRegions("BR", year),

  fields(year): FieldSpec[] {
    return loadGeneric<BrRules>("BR", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<BrRules>("BR", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "BR",
      currency: "BRL",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("br", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Between R$ 5.000 and R$ 7.350 a month the redutor is being withdrawn at 13,3 centavos in the real, on top of the table rate.",
    });
  },
};
