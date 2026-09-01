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
import it2026 from "../../rules/it/2026/national.json";

registerGeneric("IT", 2026, it2026);

interface ItRegion extends GenericRegion {
  regionalRate: string;
  municipalRate: string;
}

interface ItRules extends GenericRuleset {
  irpef: ScaleSpec;
  inps: { legalRef: string; employeeRate: string; note: string };
  detrazioneLavoro: {
    legalRef: string;
    lowIncomeLimit: string;
    lowIncomeAmount: string;
    midLimit: string;
    midBase: string;
    midExtra: string;
    midRange: string;
    highLimit: string;
    highBase: string;
    highRange: string;
    note: string;
  };
  trattamentoIntegrativo: { legalRef: string; incomeLimit: string; amount: string; note: string };
}

const LOCALE = "it-IT";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Italy's pipeline. The employment credit is the mechanism that matters: it is
 * a credit against the tax that tapers away completely by EUR 50,000, and it is
 * what creates the Italian no-tax area rather than any allowance against
 * income. Below EUR 15,000 the trattamento integrativo goes further still and
 * is PAID to the worker even when it exceeds the tax due, so it is not a credit
 * at all but a transfer sitting inside the tax computation.
 *
 * Both regional and municipal surcharges are then charged on the whole income,
 * not on the tax and not on the income above a threshold.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<ItRules>("IT", input.year);
  const region = genericRegion<ItRegion>(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Retribuzione lorda ---------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "it-1",
    label: "Retribuzione lorda annua",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. Contributi INPS -------------------------------------------------------- */
  const inps = trace.add({
    id: "it-2",
    label: "Contributi INPS a carico del lavoratore",
    formula: `${pct(d(rules.inps.employeeRate))} x ${f(gross)}`,
    inputs: { aliquota: d(rules.inps.employeeRate) },
    output: round(gross.times(d(rules.inps.employeeRate)), R),
    legalRef: rules.inps.legalRef,
    note: rules.inps.note,
    unit: "money",
  });

  /* 3. Reddito complessivo ----------------------------------------------------- */
  const previdenza = readAnnual(v, "previdenzaComplementare");
  const reddito = trace.add({
    id: "it-3",
    label: "Reddito complessivo",
    formula: `${f(gross)} - ${f(inps)} (INPS) - ${f(previdenza)} (previdenza complementare)`,
    inputs: { lordo: gross, INPS: inps, "previdenza complementare": previdenza },
    output: floorZero(round(gross.minus(inps).minus(previdenza), R)),
    legalRef: "Art. 51 TUIR",
    unit: "money",
  });

  /* 4. IRPEF lorda ------------------------------------------------------------- */
  const scale = evaluateScale(reddito, rules.irpef, R);
  const irpefLorda = trace.add({
    id: "it-4",
    label: "IRPEF lorda",
    formula: `scaglioni(${f(reddito)})`,
    inputs: { "reddito complessivo": reddito },
    output: scale.total,
    legalRef: rules.irpef.legalRef,
    note: rules.irpef.note,
    bands: scale.rows,
    unit: "money",
  });

  /* 5. Detrazione da lavoro dipendente ----------------------------------------- */
  const det = rules.detrazioneLavoro;
  let detrazione = ZERO;
  let detFormula: string;
  if (reddito.lte(d(det.lowIncomeLimit))) {
    detrazione = d(det.lowIncomeAmount);
    detFormula = `${f(d(det.lowIncomeAmount))} - reddito fino a ${f(d(det.lowIncomeLimit))}`;
  } else if (reddito.lte(d(det.midLimit))) {
    detrazione = round(
      d(det.midBase).plus(
        d(det.midExtra).times(d(det.midLimit).minus(reddito)).dividedBy(d(det.midRange)),
      ),
      R,
    );
    detFormula = `${f(d(det.midBase))} + ${f(d(det.midExtra))} x (${f(d(det.midLimit))} - ${f(reddito)}) / ${f(d(det.midRange))}`;
  } else if (reddito.lt(d(det.highLimit))) {
    detrazione = round(
      d(det.highBase).times(d(det.highLimit).minus(reddito)).dividedBy(d(det.highRange)),
      R,
    );
    detFormula = `${f(d(det.highBase))} x (${f(d(det.highLimit))} - ${f(reddito)}) / ${f(d(det.highRange))}`;
  } else {
    detFormula = `0 - la detrazione si azzera a ${f(d(det.highLimit))}`;
  }
  const detrazioneUsed = min(detrazione, irpefLorda);

  trace.add({
    id: "it-5",
    label: "Detrazione per redditi di lavoro dipendente",
    formula: detFormula,
    inputs: { "detrazione spettante": detrazione, "detrazione utilizzata": detrazioneUsed },
    output: detrazioneUsed,
    legalRef: det.legalRef,
    note: det.note,
    unit: "money",
  });

  const irpefNetta = trace.add({
    id: "it-6",
    label: "IRPEF netta",
    formula: `max(0, ${f(irpefLorda)} - ${f(detrazioneUsed)})`,
    inputs: { "IRPEF lorda": irpefLorda, detrazione: detrazioneUsed },
    output: floorZero(round(irpefLorda.minus(detrazioneUsed), R)),
    unit: "money",
  });

  /* 6. Trattamento integrativo -------------------------------------------------- */
  const ti = rules.trattamentoIntegrativo;
  const tiDue =
    reddito.gt(0) && reddito.lte(d(ti.incomeLimit)) && irpefLorda.gt(detrazione)
      ? d(ti.amount)
      : ZERO;
  trace.add({
    id: "it-7",
    label: "Trattamento integrativo",
    formula: tiDue.gt(0)
      ? `${f(d(ti.amount))} - reddito entro ${f(d(ti.incomeLimit))} e IRPEF lorda superiore alla detrazione`
      : "0 - le condizioni non sono soddisfatte",
    inputs: { "reddito complessivo": reddito, "IRPEF lorda": irpefLorda, detrazione },
    output: tiDue,
    legalRef: ti.legalRef,
    note: ti.note,
    unit: "money",
  });

  /* 7. Addizionali ------------------------------------------------------------- */
  const regionale = round(reddito.times(d(region.regionalRate)), R);
  const comunale = round(reddito.times(d(region.municipalRate)), R);
  const addizionali = trace.add({
    id: "it-8",
    label: `Addizionali regionale e comunale (${region.name})`,
    formula: `${pct(d(region.regionalRate))} x ${f(reddito)} = ${f(regionale)} + ${pct(d(region.municipalRate))} x ${f(reddito)} = ${f(comunale)}`,
    inputs: { "addizionale regionale": regionale, "addizionale comunale": comunale },
    output: round(regionale.plus(comunale), R),
    legalRef: "D.Lgs. 360/1998; D.Lgs. 446/1997",
    note: "Both surcharges are charged on the whole income and neither is reduced by the employment credit, so they are due even where IRPEF itself is nil.",
    unit: "money",
  });

  const totalTax = trace.add({
    id: "it-9",
    label: "Imposta complessiva",
    formula: `${f(irpefNetta)} (IRPEF netta) + ${f(addizionali)} (addizionali) - ${f(tiDue)} (trattamento integrativo)`,
    inputs: { "IRPEF netta": irpefNetta, addizionali, "trattamento integrativo": tiDue },
    output: round(irpefNetta.plus(addizionali).minus(tiDue), R),
    note: "The trattamento integrativo is subtracted here because it is paid to the worker, so it reduces the net burden even below zero IRPEF.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "it-10",
    label: "Conguaglio",
    formula: `${f(withheld)} (trattenute) - ${f(totalTax)} (imposta)`,
    inputs: { trattenute: withheld, imposta: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (reddito.gt(d(det.midLimit)) && reddito.lt(d(det.highLimit))) {
    warnings.push(
      "Your income sits in the range where the employment credit is being withdrawn, so your effective marginal rate is above the 35% headline band rate.",
    );
  }

  return { trace, grossAssessed: gross, social: inps, incomeTax: totalTax, withheld, months, warnings };
}

export const itAdapter: CountryAdapter = {
  country: "IT",
  currency: "EUR",
  locale: LOCALE,
  label: "Italy",
  contributionLabel: "Contributi INPS",
  regionLabel: "Regione e comune",
  regionNote:
    "The regional surcharge runs from 1,23% to 3,33% and the municipal surcharge adds up to 0,9% more, both charged on your whole income. Choosing the wrong one moves the answer by more than a percentage point of gross pay.",

  years: () => genericYears("IT"),
  regions: (year) => genericRegions("IT", year),

  fields(year): FieldSpec[] {
    return loadGeneric<ItRules>("IT", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<ItRules>("IT", input.year);
    const region = genericRegion<ItRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "IT",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("it", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Between EUR 15.000 and EUR 50.000 the employment credit is being withdrawn, which adds several points to the true marginal rate.",
    });
  },
};
