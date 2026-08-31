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
import { readMonthly, readAnnual, readBool, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import de2026 from "../../rules/de/2026/national.json";

registerGeneric("DE", 2026, de2026);

interface DeRegion extends GenericRegion {
  churchTaxRate: string;
}

interface DeRules extends GenericRuleset {
  tariff: {
    legalRef: string;
    note: string;
    grundfreibetrag: string;
    zone2Upper: string;
    zone3Upper: string;
    zone4Upper: string;
    zone2: { a: string; b: string };
    zone3: { a: string; b: string; c: string; offset: string };
    zone4: { rate: string; subtract: string };
    zone5: { rate: string; subtract: string };
  };
  solidaritySurcharge: {
    legalRef: string;
    rate: string;
    freigrenze: string;
    milderungszoneRate: string;
    note: string;
  };
  socialInsurance: {
    legalRef: string;
    note: string;
    pension: { employeeRate: string; monthlyCeiling: string };
    unemployment: { employeeRate: string; monthlyCeiling: string };
    health: {
      baseEmployeeRate: string;
      averageZusatzbeitrag: string;
      employeeShareOfZusatzbeitrag: string;
      monthlyCeiling: string;
    };
    longTermCare: {
      employeeRate: string;
      childlessSurcharge: string;
      childlessFromAge: number;
      monthlyCeiling: string;
    };
  };
  deductions: {
    arbeitnehmerPauschbetrag: string;
    sonderausgabenPauschbetrag: string;
    altersvorsorgeHoechstbetrag: string;
    healthDeductibleFactor: string;
    note: string;
  };
  rounding: GenericRuleset["rounding"] & { taxableIncomeDp: number; finalTaxDp: number };
}

const LOCALE = "de-DE";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * The German tariff of § 32a EStG. This is NOT a bracket table: zones 2 and 3
 * are quadratics, so the marginal rate climbs continuously from 14% to 42%
 * rather than jumping at thresholds. Approximating it with brackets would be
 * wrong at every income between 12.348 and 69.878 EUR.
 */
export function tarif(zvE: Decimal, t: DeRules["tariff"]): { tax: Decimal; zone: number; formula: string } {
  const x = zvE.floor();
  const gfb = d(t.grundfreibetrag);

  if (x.lte(gfb)) {
    return { tax: ZERO, zone: 1, formula: `0 - taxable income is within the Grundfreibetrag of ${f(gfb)}` };
  }
  if (x.lte(d(t.zone2Upper))) {
    const y = x.minus(gfb).dividedBy(10000);
    const tax = d(t.zone2.a).times(y).plus(d(t.zone2.b)).times(y);
    return {
      tax: tax.floor(),
      zone: 2,
      formula: `(${t.zone2.a} x y + ${t.zone2.b}) x y, where y = (${f(x)} - ${f(gfb)}) / 10.000 = ${y.toFixed(6)}`,
    };
  }
  if (x.lte(d(t.zone3Upper))) {
    const z = x.minus(d(t.zone3.offset)).dividedBy(10000);
    const tax = d(t.zone3.a).times(z).plus(d(t.zone3.b)).times(z).plus(d(t.zone3.c));
    return {
      tax: tax.floor(),
      zone: 3,
      formula: `(${t.zone3.a} x z + ${t.zone3.b}) x z + ${t.zone3.c}, where z = (${f(x)} - ${f(d(t.zone3.offset))}) / 10.000 = ${z.toFixed(6)}`,
    };
  }
  if (x.lte(d(t.zone4Upper))) {
    const tax = d(t.zone4.rate).times(x).minus(d(t.zone4.subtract));
    return {
      tax: tax.floor(),
      zone: 4,
      formula: `${t.zone4.rate} x ${f(x)} - ${f(d(t.zone4.subtract))}`,
    };
  }
  const tax = d(t.zone5.rate).times(x).minus(d(t.zone5.subtract));
  return { tax: tax.floor(), zone: 5, formula: `${t.zone5.rate} x ${f(x)} - ${f(d(t.zone5.subtract))}` };
}

function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<DeRules>("DE", input.year);
  const region = genericRegion<DeRegion>(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Gross pay ------------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "de-1",
    label: "Bruttoarbeitslohn (annual gross pay)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    legalRef: "§ 19 EStG",
    unit: "money",
  });

  /* 2. Social insurance, each branch on its own monthly ceiling -------------- */
  const si = rules.socialInsurance;
  const childless = readBool(v, "childless");
  const zusatzEmployee = d(si.health.averageZusatzbeitrag).times(
    d(si.health.employeeShareOfZusatzbeitrag),
  );
  const healthRate = d(si.health.baseEmployeeRate).plus(zusatzEmployee);
  const careRate = d(si.longTermCare.employeeRate).plus(
    childless ? d(si.longTermCare.childlessSurcharge) : ZERO,
  );

  const perMonth = (rate: Decimal, ceiling: Decimal) =>
    monthlyGross.map((g) => round(min(g, ceiling).times(rate), R));

  const pensionCeiling = d(si.pension.monthlyCeiling);
  const healthCeiling = d(si.health.monthlyCeiling);
  const pension = round(sum(perMonth(d(si.pension.employeeRate), pensionCeiling)), R);
  const unemployment = round(sum(perMonth(d(si.unemployment.employeeRate), pensionCeiling)), R);
  const health = round(sum(perMonth(healthRate, healthCeiling)), R);
  const care = round(sum(perMonth(careRate, healthCeiling)), R);

  const social = trace.add({
    id: "de-2",
    label: "Sozialversicherung (employee share)",
    formula: `${f(pension)} (Rente ${pct(d(si.pension.employeeRate))}) + ${f(unemployment)} (Arbeitslos ${pct(d(si.unemployment.employeeRate))}) + ${f(health)} (Kranken ${pct(healthRate)}) + ${f(care)} (Pflege ${pct(careRate)})`,
    inputs: {
      Rentenversicherung: pension,
      Arbeitslosenversicherung: unemployment,
      Krankenversicherung: health,
      Pflegeversicherung: care,
      "monatliche BBG Rente/Arbeitslos": pensionCeiling,
      "monatliche BBG Kranken/Pflege": healthCeiling,
    },
    output: round(sum([pension, unemployment, health, care]), R),
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* 3. Werbungskosten -------------------------------------------------------- */
  const actualWk = readAnnual(v, "werbungskosten");
  const pauschbetrag = d(rules.deductions.arbeitnehmerPauschbetrag);
  const werbungskosten = max(actualWk, pauschbetrag);
  trace.add({
    id: "de-3",
    label: "Werbungskosten",
    formula: `max(${f(actualWk)} actual, ${f(pauschbetrag)} Arbeitnehmer-Pauschbetrag)`,
    inputs: { actual: actualWk, "Arbeitnehmer-Pauschbetrag": pauschbetrag },
    output: werbungskosten,
    legalRef: "§ 9a Satz 1 Nr. 1a EStG",
    unit: "money",
  });

  /* 4. Vorsorgeaufwendungen as Sonderausgaben ------------------------------- */
  const hoechstbetrag = d(rules.deductions.altersvorsorgeHoechstbetrag);
  // The employer pays a matching pension share; the cap applies to the pair and
  // the employer share is then subtracted again. Within the ceiling this always
  // returns the employee share, but the full rule is applied so a change to the
  // Hoechstbetrag behaves correctly.
  const combinedPension = pension.times(2);
  const altersvorsorge = floorZero(min(combinedPension, hoechstbetrag).minus(pension));
  const healthDeductible = round(
    health.times(d(rules.deductions.healthDeductibleFactor)).plus(care),
    R,
  );
  const sonderausgaben = trace.add({
    id: "de-4",
    label: "Vorsorgeaufwendungen (Sonderausgaben)",
    formula: `${f(altersvorsorge)} (Altersvorsorge, Hoechstbetrag ${f(hoechstbetrag)}) + ${f(healthDeductible)} (Basiskranken- und Pflegeversicherung) + ${f(d(rules.deductions.sonderausgabenPauschbetrag))} (Pauschbetrag)`,
    inputs: {
      Altersvorsorgeaufwendungen: altersvorsorge,
      "Kranken- und Pflegeversicherung": healthDeductible,
      "Sonderausgaben-Pauschbetrag": d(rules.deductions.sonderausgabenPauschbetrag),
    },
    output: round(
      altersvorsorge.plus(healthDeductible).plus(d(rules.deductions.sonderausgabenPauschbetrag)),
      R,
    ),
    legalRef: "§§ 10 Abs. 1 Nr. 2, 3 und 3a, 10c EStG",
    note: rules.deductions.note,
    unit: "money",
  });

  /* 5. Zu versteuerndes Einkommen -------------------------------------------- */
  const zvE = trace.add({
    id: "de-5",
    label: "Zu versteuerndes Einkommen",
    formula: `${f(gross)} - ${f(werbungskosten)} (Werbungskosten) - ${f(sonderausgaben)} (Sonderausgaben)`,
    inputs: { Bruttolohn: gross, Werbungskosten: werbungskosten, Sonderausgaben: sonderausgaben },
    output: floorZero(gross.minus(werbungskosten).minus(sonderausgaben)).floor(),
    legalRef: "§ 2 Abs. 5 EStG",
    note: "Rounded down to whole euros, as § 32a requires.",
    unit: "money",
  });

  /* 6. The tariff ------------------------------------------------------------ */
  const result = tarif(zvE, rules.tariff);
  const einkommensteuer = trace.add({
    id: "de-6",
    label: `Einkommensteuer (Grundtarif, Zone ${result.zone})`,
    formula: result.formula,
    inputs: { "zu versteuerndes Einkommen": zvE, Grundfreibetrag: d(rules.tariff.grundfreibetrag) },
    output: result.tax,
    legalRef: rules.tariff.legalRef,
    note: rules.tariff.note,
    unit: "money",
  });

  /* 7. Solidarity surcharge with its Milderungszone -------------------------- */
  const soli = rules.solidaritySurcharge;
  const freigrenze = d(soli.freigrenze);
  let soliAmount = ZERO;
  let soliFormula: string;
  if (einkommensteuer.lte(freigrenze)) {
    soliFormula = `0 - assessed income tax of ${f(einkommensteuer)} is within the Freigrenze of ${f(freigrenze)}`;
  } else {
    const full = einkommensteuer.times(d(soli.rate));
    const capped = einkommensteuer.minus(freigrenze).times(d(soli.milderungszoneRate));
    soliAmount = round(min(full, capped), R);
    soliFormula =
      capped.lt(full)
        ? `min(${pct(d(soli.rate))} x ${f(einkommensteuer)}, ${pct(d(soli.milderungszoneRate))} x (${f(einkommensteuer)} - ${f(freigrenze)})) - inside the Milderungszone`
        : `${pct(d(soli.rate))} x ${f(einkommensteuer)}`;
  }
  const soliStep = trace.add({
    id: "de-7",
    label: "Solidaritätszuschlag",
    formula: soliFormula,
    inputs: { Einkommensteuer: einkommensteuer, Freigrenze: freigrenze },
    output: soliAmount,
    legalRef: soli.legalRef,
    note: soli.note,
    unit: "money",
  });

  /* 8. Church tax ------------------------------------------------------------ */
  const isMember = readBool(v, "churchMember");
  const churchRate = d(region.churchTaxRate);
  const church = trace.add({
    id: "de-8",
    label: "Kirchensteuer",
    formula: isMember
      ? `${pct(churchRate)} x ${f(einkommensteuer)} (${region.name})`
      : "0 - not a member of a tax-collecting church",
    inputs: { Einkommensteuer: einkommensteuer, Kirchensteuersatz: churchRate },
    output: isMember ? round(einkommensteuer.times(churchRate), R) : ZERO,
    legalRef: "Kirchensteuergesetze der Länder",
    note: "Church tax is charged on the income tax, not on income, so it is 8% or 9% of the tax bill and nothing at all if you are not a member.",
    unit: "money",
  });

  const totalTax = trace.add({
    id: "de-9",
    label: "Steuerlast insgesamt",
    formula: `${f(einkommensteuer)} (Einkommensteuer) + ${f(soliStep)} (Soli) + ${f(church)} (Kirchensteuer)`,
    inputs: { Einkommensteuer: einkommensteuer, Solidaritätszuschlag: soliStep, Kirchensteuer: church },
    output: round(einkommensteuer.plus(soliStep).plus(church), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "de-10",
    label: "Erstattung oder Nachzahlung",
    formula: `${f(withheld)} (Lohnsteuer withheld) - ${f(totalTax)} (Steuerlast)`,
    inputs: { "Lohnsteuer withheld": withheld, Steuerlast: totalTax },
    output: round(withheld.minus(totalTax), R),
    note: "Positive means a refund. Monthly wage tax is computed on an annualised basis, so an uneven year almost always produces a refund.",
    unit: "money",
  });

  if (result.zone === 2 || result.zone === 3) {
    warnings.push(
      "Your income falls in a progression zone, where the marginal rate rises continuously rather than in steps. There is no single bracket rate to quote.",
    );
  }

  return { trace, grossAssessed: gross, social, incomeTax: totalTax, withheld, months, warnings };
}

export const deAdapter: CountryAdapter = {
  country: "DE",
  currency: "EUR",
  locale: LOCALE,
  label: "Germany",
  contributionLabel: "Sozialversicherung",
  regionLabel: "Bundesland",
  regionNote:
    "Germany has no regional income tax, but the church tax rate is 8% in Bavaria and Baden-Württemberg and 9% everywhere else, so the state matters if you are a church member.",

  years: () => genericYears("DE"),
  regions: (year) => genericRegions("DE", year),

  fields(year): FieldSpec[] {
    return loadGeneric<DeRules>("DE", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<DeRules>("DE", input.year);
    const region = genericRegion<DeRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "DE",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("de", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "In the progression zones the marginal rate rises with every euro earned, so this figure is the rate on your next 100 EUR and not a bracket rate.",
    });
  },
};
