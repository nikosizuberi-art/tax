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
import { evaluateScale, marginalRateAt } from "../engine/brackets";
import { Trace, serialiseTrace } from "../engine/trace";
import { loadEs, esRegions, esYears, stamp } from "../engine/registry";
import {
  readMonthly,
  readAnnual,
  readInt,
  readBool,
  readEnum,
  monthsWorked,
  withProbe,
  MONTHS,
} from "../engine/inputs";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";

const f = (v: Decimal) => formatPlain(v, "EUR");
// Rates are shown Spanish-style with a decimal comma, to match the money formatting.
const pct = (v: Decimal) =>
  `${v.times(100).toFixed(3).replace(/\.?0+$/, "").replace(".", ",")}%`;

interface Core {
  trace: Trace;
  workGross: Decimal;
  savings: Decimal;
  social: Decimal;
  incomeTax: Decimal;
  withheld: Decimal;
  months: number;
  warnings: string[];
  marginalStatutory: Decimal;
}

/**
 * Spain's pipeline. The personal and family minimum is NOT a deduction from
 * income: the scales are applied to the full base and then again to the
 * minimum, and the second result is subtracted from the first. Feeding
 * (base - minimum) into the brackets would give a different, wrong answer.
 */
function core(input: CalcInput, probe: Decimal): Core {
  const { national, region } = loadEs(input.year, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: national.rounding.moneyDp, mode: national.rounding.mode };

  /* 1. Annual gross ------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const workGross = trace.add({
    id: "es-1",
    label: "Rendimiento íntegro del trabajo (annual gross)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    legalRef: "Art. 17 LIRPF",
    note:
      months === 12
        ? undefined
        : `Only ${months} month(s) carry income. A partial year is taxed on the actual total; it is never annualised.`,
    unit: "money",
  });

  /* 2. Social security (employee share) - the cap is MONTHLY -------------- */
  const ssRates = national.socialSecurity.rates;
  const contractType = readEnum(v, "contractType", "indefinido");
  const desempleo =
    contractType === "temporal" ? d(ssRates.desempleoTemporal) : d(ssRates.desempleoIndefinido);
  const ssRate = d(ssRates.contingenciasComunes)
    .plus(desempleo)
    .plus(d(ssRates.formacionProfesional))
    .plus(d(ssRates.mei));
  const maxBase = d(national.socialSecurity.monthlyMaxBase);

  const ssOverride = readMonthly(v, "socialSecurityOverrideMonthly");
  const ssOverridden = ssOverride.some((m) => m.gt(0));

  const monthlySs = monthlyGross.map((g, i) =>
    ssOverridden ? ssOverride[i] : round(min(g, maxBase).times(ssRate), R),
  );
  const cappedMonths = monthlyGross.filter((g) => g.gt(maxBase)).length;

  const social = trace.add({
    id: "es-2",
    label: "Seguridad Social a cargo del trabajador",
    formula: ssOverridden
      ? "sum of the monthly figures you entered (override)"
      : `sum over 12 months of min(monthly gross, ${f(maxBase)}) x ${pct(ssRate)}`,
    inputs: {
      "contingencias comunes": d(ssRates.contingenciasComunes),
      desempleo,
      "formacion profesional": d(ssRates.formacionProfesional),
      MEI: d(ssRates.mei),
      "tipo total": ssRate,
      "base maxima mensual": maxBase,
    },
    output: round(sum(monthlySs), R),
    legalRef: national.socialSecurity.legalRef,
    note: ssOverridden
      ? "Computed figure replaced by the monthly amounts you entered."
      : cappedMonths > 0
        ? `${cappedMonths} month(s) exceeded the monthly maximum base, so contributions were capped in those months. The cap is monthly, not annual.`
        : undefined,
    unit: "money",
  });

  /* 3. Gastos deducibles -------------------------------------------------- */
  const unionDues = readAnnual(v, "cuotasSindicales");
  const colegios = min(
    readAnnual(v, "colegiosProfesionales"),
    d(national.gastosDeducibles.topeColegiosProfesionales),
  );
  const defensa = min(
    readAnnual(v, "defensaJuridica"),
    d(national.gastosDeducibles.topeDefensaJuridica),
  );
  const namedGastos = social.plus(unionDues).plus(colegios).plus(defensa);
  const otrosGastos = min(
    d(national.gastosDeducibles.otrosGastosGenerico),
    floorZero(workGross.minus(namedGastos)),
  );
  const gastos = trace.add({
    id: "es-3",
    label: "Gastos deducibles",
    formula: `${f(social)} (SS) + ${f(unionDues)} (cuotas sindicales) + ${f(colegios)} (colegios, tope ${f(d(national.gastosDeducibles.topeColegiosProfesionales))}) + ${f(defensa)} (defensa jurídica, tope ${f(d(national.gastosDeducibles.topeDefensaJuridica))}) + ${f(otrosGastos)} (otros gastos)`,
    inputs: {
      "seguridad social": social,
      "cuotas sindicales": unionDues,
      "colegios profesionales": colegios,
      "defensa jurídica": defensa,
      "otros gastos": otrosGastos,
    },
    output: round(namedGastos.plus(otrosGastos), R),
    legalRef: national.gastosDeducibles.legalRef,
    note: "The 2.000 EUR otros gastos allowance cannot push the net work income below zero, so it is limited to what is left after the other gastos.",
    unit: "money",
  });

  /* 4. Rendimiento neto --------------------------------------------------- */
  const rendimientoNeto = trace.add({
    id: "es-4",
    label: "Rendimiento neto del trabajo",
    formula: `${f(workGross)} - ${f(gastos)}`,
    inputs: { "rendimiento íntegro": workGross, "gastos deducibles": gastos },
    output: round(workGross.minus(gastos), R),
    legalRef: "Art. 19 LIRPF",
    unit: "money",
  });

  /* 5. Reducción por obtención de rendimientos del trabajo ---------------- */
  const red = national.reduccionRendimientosTrabajo;
  const savings = readAnnual(v, "savingsIncome");
  const otherIncomeLimit = d(red.otherIncomeLimit);
  let reduccionTrabajo = ZERO;
  let reduccionFormula: string;

  if (savings.gt(otherIncomeLimit)) {
    reduccionFormula = `0 - other income of ${f(savings)} exceeds the ${f(otherIncomeLimit)} limit`;
  } else if (rendimientoNeto.lte(d(red.floor))) {
    reduccionTrabajo = d(red.amount);
    reduccionFormula = `${f(d(red.amount))} - net work income is at or below ${f(d(red.floor))}`;
  } else if (rendimientoNeto.lt(d(red.ceiling))) {
    reduccionTrabajo = floorZero(
      d(red.amount).minus(d(red.taperFactor).times(rendimientoNeto.minus(d(red.floor)))),
    );
    reduccionFormula = `${f(d(red.amount))} - ${red.taperFactor} x (${f(rendimientoNeto)} - ${f(d(red.floor))})`;
  } else {
    reduccionFormula = `0 - net work income is at or above ${f(d(red.ceiling))}`;
  }
  reduccionTrabajo = min(round(reduccionTrabajo, R), floorZero(rendimientoNeto));

  trace.add({
    id: "es-5",
    label: "Reducción por obtención de rendimientos del trabajo",
    formula: reduccionFormula,
    inputs: {
      "rendimiento neto": rendimientoNeto,
      "importe maximo": d(red.amount),
      suelo: d(red.floor),
      techo: d(red.ceiling),
      "factor de reduccion": d(red.taperFactor),
    },
    output: reduccionTrabajo,
    legalRef: red.legalRef,
    note: red.note,
    unit: "money",
  });

  /* 6. Base imponible general -------------------------------------------- */
  const baseImponible = trace.add({
    id: "es-6",
    label: "Base imponible general",
    formula: `${f(rendimientoNeto)} - ${f(reduccionTrabajo)}`,
    inputs: { "rendimiento neto": rendimientoNeto, reduccion: reduccionTrabajo },
    output: floorZero(round(rendimientoNeto.minus(reduccionTrabajo), R)),
    legalRef: "Art. 48 LIRPF",
    unit: "money",
  });

  /* 7. Reducciones -> base liquidable general ----------------------------- */
  const pensionCapPct = d(national.pensionPlan.percentOfWorkIncome).times(floorZero(rendimientoNeto));
  const pensionCap = min(pensionCapPct, d(national.pensionPlan.absoluteCap));
  const pensionClaimed = min(min(readAnnual(v, "pensionPlan"), pensionCap), baseImponible);
  const baseLiquidable = trace.add({
    id: "es-7",
    label: "Base liquidable general",
    formula: `${f(baseImponible)} - ${f(pensionClaimed)} (planes de pensiones, limite = min(30% x ${f(floorZero(rendimientoNeto))}, ${f(d(national.pensionPlan.absoluteCap))}))`,
    inputs: {
      "base imponible general": baseImponible,
      "aportacion computada": pensionClaimed,
      "limite porcentual": pensionCapPct,
      "limite absoluto": d(national.pensionPlan.absoluteCap),
    },
    output: floorZero(round(baseImponible.minus(pensionClaimed), R)),
    legalRef: national.pensionPlan.legalRef,
    note: "Contributions above the limit or above the base are not lost; they can be carried forward to the following five years. v1 does not track the carry-forward.",
    unit: "money",
  });

  /* 8. Mínimo personal y familiar ----------------------------------------- */
  const m = { ...national.minimos, ...(region.minimoOverrides ?? {}) };
  const age = readInt(v, "age", 40);
  const children = readInt(v, "childrenUnder25");
  const under3 = Math.min(readInt(v, "childrenUnder3"), children);
  const disability = readEnum(v, "disabilityDegree", "none");

  const childAmounts = m.descendientes.map(d);
  let childTotal = ZERO;
  for (let i = 1; i <= children; i++) {
    childTotal = childTotal.plus(childAmounts[Math.min(i, childAmounts.length) - 1]);
  }
  const under3Total = d(m.descendienteMenor3Extra).times(under3);
  const ageUplift = (age >= 65 ? d(m.mayor65) : ZERO).plus(age >= 75 ? d(m.mayor75Extra) : ZERO);
  const disabilityAmount =
    disability === "d65" ? d(m.discapacidad65mas) : disability === "d33" ? d(m.discapacidad33a64) : ZERO;

  const minimo = trace.add({
    id: "es-8",
    label: "Mínimo personal y familiar",
    formula: `${f(d(m.personal))} (personal) + ${f(ageUplift)} (edad) + ${f(childTotal)} (${children} descendiente(s)) + ${f(under3Total)} (${under3} menor(es) de 3) + ${f(disabilityAmount)} (discapacidad)`,
    inputs: {
      personal: d(m.personal),
      edad: ageUplift,
      descendientes: childTotal,
      "menores de 3": under3Total,
      discapacidad: disabilityAmount,
    },
    output: round(d(m.personal).plus(ageUplift).plus(childTotal).plus(under3Total).plus(disabilityAmount), R),
    legalRef: m.legalRef,
    note: "Descendant amounts escalate by birth order and are halved under shared custody, which v1 does not model.",
    unit: "money",
  });

  /* 9. Cuota íntegra - the scale is applied twice ------------------------- */
  const minimoGeneral = min(minimo, baseLiquidable);
  const minimoResto = minimo.minus(minimoGeneral);

  const stateOnBase = evaluateScale(baseLiquidable, national.stateScale, R);
  const stateOnMin = evaluateScale(minimoGeneral, national.stateScale, R);
  const cuotaEstatal = trace.add({
    id: "es-9a",
    label: "Cuota íntegra estatal",
    formula: `escala_estatal(${f(baseLiquidable)}) - escala_estatal(${f(minimoGeneral)}) = ${f(stateOnBase.total)} - ${f(stateOnMin.total)}`,
    inputs: {
      "base liquidable general": baseLiquidable,
      "minimo aplicado a la base general": minimoGeneral,
      "cuota sobre la base": stateOnBase.total,
      "cuota sobre el minimo": stateOnMin.total,
    },
    output: floorZero(round(stateOnBase.total.minus(stateOnMin.total), R)),
    legalRef: national.stateScale.legalRef,
    note: national.stateScale.note,
    bands: stateOnBase.rows,
    unit: "money",
  });

  const regionOnBase = evaluateScale(baseLiquidable, region.generalScale, R);
  const regionOnMin = evaluateScale(minimoGeneral, region.generalScale, R);
  const cuotaAutonomica = trace.add({
    id: "es-9b",
    label: `Cuota íntegra autonómica (${region.regionName})`,
    formula: `escala_autonómica(${f(baseLiquidable)}) - escala_autonómica(${f(minimoGeneral)}) = ${f(regionOnBase.total)} - ${f(regionOnMin.total)}`,
    inputs: {
      "base liquidable general": baseLiquidable,
      "minimo aplicado a la base general": minimoGeneral,
      "cuota sobre la base": regionOnBase.total,
      "cuota sobre el minimo": regionOnMin.total,
    },
    output: floorZero(round(regionOnBase.total.minus(regionOnMin.total), R)),
    legalRef: region.generalScale.legalRef,
    bands: regionOnBase.rows,
    unit: "money",
  });

  /* 10. Savings base ------------------------------------------------------ */
  const minimoAhorro = min(minimoResto, savings);
  const savingsOnBase = evaluateScale(savings, national.savingsScale, R);
  const savingsOnMin = evaluateScale(minimoAhorro, national.savingsScale, R);
  const cuotaAhorro = trace.add({
    id: "es-10",
    label: "Cuota íntegra del ahorro",
    formula: savings.isZero()
      ? "0 - no savings income entered"
      : `escala_ahorro(${f(savings)}) - escala_ahorro(${f(minimoAhorro)}) = ${f(savingsOnBase.total)} - ${f(savingsOnMin.total)}`,
    inputs: {
      "base liquidable del ahorro": savings,
      "resto del minimo aplicable al ahorro": minimoAhorro,
    },
    output: floorZero(round(savingsOnBase.total.minus(savingsOnMin.total), R)),
    legalRef: national.savingsScale.legalRef,
    note: national.savingsScale.note,
    bands: savingsOnBase.rows,
    unit: "money",
  });

  const cuotaIntegra = trace.add({
    id: "es-10b",
    label: "Cuota íntegra total",
    formula: `${f(cuotaEstatal)} (estatal) + ${f(cuotaAutonomica)} (autonómica) + ${f(cuotaAhorro)} (ahorro)`,
    inputs: { estatal: cuotaEstatal, autonómica: cuotaAutonomica, ahorro: cuotaAhorro },
    output: round(cuotaEstatal.plus(cuotaAutonomica).plus(cuotaAhorro), R),
    unit: "money",
  });

  /* 11. Deducciones -> cuota líquida -------------------------------------- */
  const don = national.donations;
  const donationsGiven = readAnnual(v, "donations");
  const donationCeiling = d(don.baseLimitPercent).times(baseLiquidable.plus(savings));
  const donationBase = min(donationsGiven, donationCeiling);
  const tier1 = min(donationBase, d(don.tier1Limit));
  const tier2Rate = readBool(v, "donationsRecurring") ? d(don.tier2RecurringRate) : d(don.tier2Rate);
  const tier2 = floorZero(donationBase.minus(d(don.tier1Limit)));
  const donationCredit = round(
    tier1.times(d(don.tier1Rate)).plus(tier2.times(tier2Rate)),
    R,
  );

  if (donationsGiven.gt(donationBase)) {
    warnings.push(
      `Donations were limited to 10% of the base liquidable (${f(donationCeiling)}). The excess is not deductible this year.`,
    );
  }

  trace.add({
    id: "es-11a",
    label: "Deducción por donativos",
    formula: donationBase.isZero()
      ? "0 - no qualifying donations entered"
      : `${pct(d(don.tier1Rate))} x ${f(tier1)} + ${pct(tier2Rate)} x ${f(tier2)}`,
    inputs: {
      "donativos declarados": donationsGiven,
      "base computable (tope 10% de la base liquidable)": donationBase,
      "primer tramo": tier1,
      "resto": tier2,
    },
    output: donationCredit,
    legalRef: don.legalRef,
    unit: "money",
  });

  const regionalCredits = region.regionalDeductions.map((rd) => {
    const eligible = readBool(v, rd.eligibilityId);
    const amount = readAnnual(v, rd.inputId);
    const credit = eligible ? min(round(amount.times(d(rd.rate)), R), d(rd.cap)) : ZERO;
    return { rd, eligible, amount, credit };
  });

  for (const { rd, eligible, amount, credit } of regionalCredits) {
    trace.add({
      id: `es-11r-${rd.id}`,
      label: rd.label,
      formula: eligible
        ? `min(${pct(d(rd.rate))} x ${f(amount)}, ${f(d(rd.cap))})`
        : "0 - eligibility not confirmed",
      inputs: { gasto: amount, tipo: d(rd.rate), limite: d(rd.cap) },
      output: credit,
      legalRef: rd.legalRef,
      note: rd.help,
      unit: "money",
    });
  }

  const deducciones = sum([donationCredit, ...regionalCredits.map((c) => c.credit)]);
  const cuotaLiquida = trace.add({
    id: "es-11",
    label: "Cuota líquida (total tax due)",
    formula: `${f(cuotaIntegra)} - ${f(deducciones)}`,
    inputs: { "cuota íntegra": cuotaIntegra, deducciones },
    output: floorZero(round(cuotaIntegra.minus(deducciones), R)),
    legalRef: "Arts. 67 y 77 LIRPF",
    unit: "money",
  });

  /* 12. Retenciones -> refund or amount owing ----------------------------- */
  const withheldMonthly = readMonthly(v, "retencionesMonthly");
  const withheld = round(sum(withheldMonthly), R);
  trace.add({
    id: "es-12",
    label: "Resultado de la declaración",
    formula: `${f(withheld)} (retenciones) - ${f(cuotaLiquida)} (cuota líquida)`,
    inputs: { retenciones: withheld, "cuota líquida": cuotaLiquida },
    output: round(withheld.minus(cuotaLiquida), R),
    note: "Positive means a refund (a devolver); negative means an amount owing (a ingresar).",
    unit: "money",
  });

  const marginalStatutory = marginalRateAt(baseLiquidable, national.stateScale).plus(
    marginalRateAt(baseLiquidable, region.generalScale),
  );

  if (!ssOverridden && cappedMonths > 0) {
    warnings.push(
      "Social security was capped in at least one month at the maximum contribution base. The additional solidarity contribution on pay above that base is not modelled.",
    );
  }
  if (months > 0 && months < 12) {
    warnings.push(
      `Income was entered for ${months} of 12 months. The year is taxed on the actual total, but the work-income reduction and the personal minimum are annual amounts and are not prorated.`,
    );
  }

  return {
    trace,
    workGross,
    savings,
    social,
    incomeTax: cuotaLiquida,
    withheld,
    months,
    warnings,
    marginalStatutory,
  };
}

const PROBE = new Decimal(100);

export const esAdapter: CountryAdapter = {
  country: "ES",
  currency: "EUR",
  locale: "es-ES",
  label: "Spain",
  contributionLabel: "Seguridad Social",
  regionLabel: "Comunidad autónoma",
  regionNote:
    "Half of Spanish income tax is set by your comunidad autonoma, and the combined top rate varies by roughly eight percentage points across regions. A result without a region would be meaningless.",

  years: () => esYears(),

  regions: (year) => esRegions(year),

  fields(year, regionCode): FieldSpec[] {
    const { national, region } = loadEs(year, regionCode);
    return [...national.inputSchema, ...region.inputSchema];
  },

  compute(input: CalcInput): CalcResult {
    const { national, region } = loadEs(input.year, input.regionCode);
    const R: Rounding = { dp: national.rounding.moneyDp, mode: national.rounding.mode };

    const base = core(input, ZERO);
    const bumped = core(input, PROBE);
    const marginal = bumped.incomeTax.minus(base.incomeTax).dividedBy(PROBE);

    const totalIncome = base.workGross.plus(base.savings);
    const takeHome = totalIncome.minus(base.social).minus(base.incomeTax);
    const denom = totalIncome.isZero() ? new Decimal(1) : totalIncome;

    base.trace.add({
      id: "es-13",
      label: "Tipo marginal efectivo",
      formula: `(cuota líquida on ${f(totalIncome.plus(PROBE))} - cuota líquida on ${f(totalIncome)}) / ${f(PROBE)}`,
      inputs: {
        "cuota actual": base.incomeTax,
        "cuota con 100 EUR mas": bumped.incomeTax,
        "tipo marginal estatal + autonomico": base.marginalStatutory,
      },
      output: marginal,
      note: "Measured by adding 100 EUR of gross pay and re-running the whole pipeline, so it includes the effect of the tapering work-income reduction, not just the bracket rates.",
      unit: "percent",
    });

    return {
      country: "ES",
      year: input.year,
      regionCode: region.regionCode,
      regionName: region.regionName,
      currency: "EUR",
      summary: {
        annualGross: totalIncome,
        socialContributions: base.social,
        incomeTax: base.incomeTax,
        totalDeductions: base.social.plus(base.incomeTax),
        takeHome,
        monthlyTakeHome: round(takeHome.dividedBy(12), R),
        effectiveRateOnGross: base.social.plus(base.incomeTax).dividedBy(denom),
        effectiveIncomeTaxRate: base.incomeTax.dividedBy(denom),
        marginalRate: marginal,
        withheld: base.withheld,
        balance: round(base.withheld.minus(base.incomeTax), R),
        monthsWorked: base.months,
      },
      steps: serialiseTrace(base.trace),
      rulesets: [stamp("es-national", national), stamp("es-region", region)],
      warnings: base.warnings,
      computedAt: new Date().toISOString(),
    };
  },
};

export { core as esCore };
export const _internals = { max, min, floorZero };
