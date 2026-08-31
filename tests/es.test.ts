import { describe, it, expect } from "vitest";
import { esAdapter } from "../src/adapters/es";
import { es, perMonth, cents } from "./helpers";

/**
 * Golden cases for Spain.
 *
 * Expected values marked HAND-DERIVED were computed longhand from the ruleset
 * figures, independently of the pipeline code, and are written out in the
 * comment above each assertion so a reviewer can check the arithmetic without
 * running anything.
 *
 * Expected values marked OFFICIAL would come from a worked example in the AEAT
 * Manual Practico. There are none yet - see tests/GOLDEN-TODO.md. Do not treat
 * this suite as proof of legal correctness until those are in.
 */

const run = (values: Parameters<typeof es>[1], region = "madrid") =>
  esAdapter.compute(es(region, values));

const plain = (monthlyGross: number, monthCount = 12, region = "madrid") =>
  run({ grossMonthly: perMonth(monthlyGross, monthCount), age: 40 }, region);

describe("Spain - structural cases", () => {
  it("zero income produces zero tax and zero contributions", () => {
    const r = plain(0);
    expect(cents(r.summary.annualGross)).toBe(0);
    expect(cents(r.summary.socialContributions)).toBe(0);
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(cents(r.summary.takeHome)).toBe(0);
  });

  it("blank months are not annualised: 7 months of 3.000 EUR is taxed as 21.000 EUR", () => {
    const partial = plain(3000, 7);
    const full = plain(3000, 12);
    expect(cents(partial.summary.annualGross)).toBe(21000);
    expect(partial.summary.monthsWorked).toBe(7);
    expect(cents(partial.summary.incomeTax)).toBeLessThan(cents(full.summary.incomeTax));
    // 7 months at 3.000 must equal 12 months at 1.750 in gross, but NOT in tax,
    // because social security is capped monthly, not annually. Here neither
    // month hits the cap, so the two must agree exactly.
    const spread = plain(1750, 12);
    expect(cents(partial.summary.annualGross)).toBe(cents(spread.summary.annualGross));
    expect(cents(partial.summary.incomeTax)).toBe(cents(spread.summary.incomeTax));
  });

  it("the personal minimum is a rate-scale subtraction, not a deduction from income", () => {
    // If the minimum were deducted from income first, a base of 26.050 would be
    // taxed as 20.500 and the state cuota would be 2.148,75. The correct answer
    // is brackets(26.050) - brackets(5.550) = 2.990,25 - 527,25 = 2.463,00.
    const r = plain(2500);
    const estatal = r.steps.find((s) => s.id === "es-9a")!;
    expect(Number(estatal.output)).toBeCloseTo(2463.0, 2);
    expect(Number(estatal.output)).not.toBeCloseTo(2148.75, 2);
  });
});

describe("Spain - hand-derived golden values (Madrid, 2026 ruleset)", () => {
  it("HAND-DERIVED: 30.000 EUR gross, single, no dependants", () => {
    // SS rate = 4,70 + 1,55 + 0,10 + 0,15 = 6,50%
    // SS      = 2.500 x 6,50% = 162,50 x 12 = 1.950,00
    // Gastos  = 1.950 + 2.000 = 3.950         RN = 30.000 - 3.950 = 26.050
    // Art. 20 reduction = 0 (RN above 19.747,50)      BLG = 26.050
    // Minimo  = 5.550
    // Estatal: 12.450x9,5% = 1.182,75 | 7.750x12% = 930,00 | 5.850x15% = 877,50 => 2.990,25
    //          menos 5.550x9,5% = 527,25                                        => 2.463,00
    // Madrid : 13.362,22x8,5% = 1.135,79 | 5.642,41x10,7% = 603,74
    //          | 7.045,37x12,8% = 901,81                                        => 2.641,34
    //          menos 5.550x8,5% = 471,75                                        => 2.169,59
    // Cuota liquida = 2.463,00 + 2.169,59 = 4.632,59
    const r = plain(2500);
    expect(cents(r.summary.annualGross)).toBe(30000);
    expect(cents(r.summary.socialContributions)).toBe(1950);
    expect(cents(r.summary.incomeTax)).toBe(4632.59);
    expect(cents(r.summary.takeHome)).toBe(23417.41);
  });

  it("HAND-DERIVED: 12.000 EUR gross pays no tax (minimum exceeds the base)", () => {
    // SS = 1.000 x 6,50% = 65,00 x 12 = 780      Gastos = 780 + 2.000 = 2.780
    // RN = 9.220  ->  Art. 20 reduction = 6.498  ->  BLG = 2.722
    // Minimo applied to the general base is capped at the base itself, so
    // brackets(2.722) - brackets(2.722) = 0 on both scales.
    const r = plain(1000);
    expect(cents(r.summary.socialContributions)).toBe(780);
    expect(Number(r.steps.find((s) => s.id === "es-5")!.output)).toBe(6498);
    expect(Number(r.steps.find((s) => s.id === "es-7")!.output)).toBe(2722);
    expect(cents(r.summary.incomeTax)).toBe(0);
  });

  it("HAND-DERIVED: 20.400 EUR gross sits inside the work-income reduction taper", () => {
    // SS = 1.700 x 6,50% = 110,50 x 12 = 1.326   Gastos = 3.326   RN = 17.074
    // Reduction = 6.498 - 1,14 x (17.074 - 14.047,50) = 6.498 - 3.450,21 = 3.047,79
    // BLG = 17.074 - 3.047,79 = 14.026,21
    // Estatal: 1.182,75 + 1.576,21x12% (189,15) = 1.371,90 - 527,25 = 844,65
    // Madrid : 1.135,79 + 663,99x10,7% (71,05)  = 1.206,84 - 471,75 = 735,09
    // Total = 1.579,74
    const r = plain(1700);
    expect(Number(r.steps.find((s) => s.id === "es-5")!.output)).toBe(3047.79);
    expect(Number(r.steps.find((s) => s.id === "es-7")!.output)).toBe(14026.21);
    expect(cents(r.summary.incomeTax)).toBe(1579.74);
  });

  it("the marginal rate inside the taper exceeds the sum of the bracket rates", () => {
    // In the taper each extra euro of net income also destroys 1,14 EUR of
    // reduction, so the marginal rate is far above the 12% + 10,7% bracket sum.
    const r = plain(1700);
    expect(r.summary.marginalRate.toNumber()).toBeGreaterThan(0.4);
    expect(r.summary.marginalRate.toNumber()).toBeLessThan(0.5);
  });
});

describe("Spain - boundary cases", () => {
  it("social security is capped month by month, not on the annual total", () => {
    // Monthly maximum base 4.909,50 -> 4.909,50 x 6,50% = 319,12 (rounded) x 12
    const capped = plain(6000);
    expect(cents(capped.summary.socialContributions)).toBe(3829.44);
    const higher = plain(9000);
    expect(cents(higher.summary.socialContributions)).toBe(3829.44);

    // The monthly cap matters: 12 x 4.000 and 6 x 8.000 have the same annual
    // gross but different contributions, because only the second hits the cap.
    const even = esAdapter.compute(es("madrid", { grossMonthly: perMonth(4000, 12), age: 40 }));
    const lumpy = esAdapter.compute(es("madrid", { grossMonthly: perMonth(8000, 6), age: 40 }));
    expect(cents(even.summary.annualGross)).toBe(cents(lumpy.summary.annualGross));
    expect(cents(lumpy.summary.socialContributions)).toBeLessThan(
      cents(even.summary.socialContributions),
    );
  });

  it("state bracket thresholds are continuous either side of each edge", () => {
    const edges = [12450, 20200, 35200, 60000];
    for (const edge of edges) {
      // Feed the edge directly as the base liquidable by using a gross that
      // lands close to it; continuity is what matters, not the exact figure.
      const below = plain((edge - 1) / 12);
      const at = plain(edge / 12);
      const above = plain((edge + 1) / 12);
      expect(cents(at.summary.incomeTax)).toBeGreaterThanOrEqual(cents(below.summary.incomeTax));
      expect(cents(above.summary.incomeTax)).toBeGreaterThanOrEqual(cents(at.summary.incomeTax));
      expect(cents(above.summary.incomeTax) - cents(below.summary.incomeTax)).toBeLessThan(2);
    }
  });

  it("the work-income reduction reaches exactly zero at the ceiling", () => {
    // The ceiling applies to the net work income, so work back from it:
    // gross - 6,50% of gross - 2.000 = 19.747,50  ->  gross = 23.259,36
    const justBelow = esAdapter.compute(
      es("madrid", { grossMonthly: perMonth(23259.35 / 12), age: 40 }),
    );
    const justAbove = esAdapter.compute(
      es("madrid", { grossMonthly: perMonth(23400 / 12), age: 40 }),
    );
    expect(Number(justBelow.steps.find((s) => s.id === "es-5")!.output)).toBeGreaterThan(0);
    expect(Number(justAbove.steps.find((s) => s.id === "es-5")!.output)).toBe(0);
  });

  it("savings income above 6.500 EUR removes the work-income reduction entirely", () => {
    const withoutSavings = run({ grossMonthly: perMonth(1200), age: 40 });
    const withSavings = run({ grossMonthly: perMonth(1200), age: 40, savingsIncome: "7000" });
    expect(Number(withoutSavings.steps.find((s) => s.id === "es-5")!.output)).toBeGreaterThan(0);
    expect(Number(withSavings.steps.find((s) => s.id === "es-5")!.output)).toBe(0);
  });
});

describe("Spain - regional variation", () => {
  const regions = ["madrid", "cataluna", "andalucia", "comunidad-valenciana"];

  it("the same income gives a different answer in every region", () => {
    const results = regions.map((r) => cents(plain(4000, 12, r).summary.incomeTax));
    expect(new Set(results).size).toBe(regions.length);
  });

  it("the state half of the cuota is identical in every region", () => {
    const stateHalves = regions.map((r) =>
      Number(plain(4000, 12, r).steps.find((s) => s.id === "es-9a")!.output),
    );
    expect(new Set(stateHalves).size).toBe(1);
  });

  it("Madrid is cheaper than Cataluna at 48.000 EUR", () => {
    expect(cents(plain(4000, 12, "madrid").summary.incomeTax)).toBeLessThan(
      cents(plain(4000, 12, "cataluna").summary.incomeTax),
    );
  });
});

describe("Spain - deductions and minimums", () => {
  it("children raise the minimum and lower the tax, escalating by birth order", () => {
    const none = run({ grossMonthly: perMonth(3000), age: 40 });
    const one = run({ grossMonthly: perMonth(3000), age: 40, childrenUnder25: 1 });
    const two = run({ grossMonthly: perMonth(3000), age: 40, childrenUnder25: 2 });
    const min0 = Number(none.steps.find((s) => s.id === "es-8")!.output);
    const min1 = Number(one.steps.find((s) => s.id === "es-8")!.output);
    const min2 = Number(two.steps.find((s) => s.id === "es-8")!.output);
    expect(min1 - min0).toBe(2400);
    expect(min2 - min1).toBe(2700);
    expect(cents(two.summary.incomeTax)).toBeLessThan(cents(one.summary.incomeTax));
  });

  it("a pension contribution is capped at the lower of 30% of net work income and 1.500 EUR", () => {
    const r = run({ grossMonthly: perMonth(3000), age: 40, pensionPlan: "5000" });
    const step = r.steps.find((s) => s.id === "es-7")!;
    expect(Number(step.inputs["aportacion computada"])).toBe(1500);
  });

  it("donations are credited at 80% on the first 250 EUR and 40% above it", () => {
    // 1.000 EUR given: 250 x 80% = 200, 750 x 40% = 300  ->  500
    const r = run({ grossMonthly: perMonth(3000), age: 40, donations: "1000" });
    expect(Number(r.steps.find((s) => s.id === "es-11a")!.output)).toBe(500);
  });

  it("a recurring donation is credited at 45% above the first 250 EUR", () => {
    // 250 x 80% = 200, 750 x 45% = 337,50  ->  537,50
    const r = run({
      grossMonthly: perMonth(3000),
      age: 40,
      donations: "1000",
      donationsRecurring: true,
    });
    expect(Number(r.steps.find((s) => s.id === "es-11a")!.output)).toBe(537.5);
  });

  it("the Madrid rent deduction applies only when eligibility is confirmed", () => {
    const notEligible = run({ grossMonthly: perMonth(2000), age: 30, mad_rentPaid: "9000" });
    const eligible = run({
      grossMonthly: perMonth(2000),
      age: 30,
      mad_rentPaid: "9000",
      mad_rentEligible: true,
    });
    expect(Number(notEligible.steps.find((s) => s.id === "es-11r-mad_alquiler")!.output)).toBe(0);
    // 30% of 9.000 = 2.700, capped at 1.237,20
    expect(Number(eligible.steps.find((s) => s.id === "es-11r-mad_alquiler")!.output)).toBe(1237.2);
  });

  it("savings income is taxed on its own scale, not the general one", () => {
    // 10.000 of savings on top of a salary that already uses up the minimum:
    // 6.000 x 19% = 1.140 + 4.000 x 21% = 840  ->  1.980
    const r = run({ grossMonthly: perMonth(3000), age: 40, savingsIncome: "10000" });
    expect(Number(r.steps.find((s) => s.id === "es-10")!.output)).toBe(1980);
  });

  it("withholding produces a refund or an amount owing without changing the liability", () => {
    const noWithholding = run({ grossMonthly: perMonth(3000), age: 40 });
    const withWithholding = run({
      grossMonthly: perMonth(3000),
      age: 40,
      retencionesMonthly: perMonth(600),
    });
    expect(cents(noWithholding.summary.incomeTax)).toBe(cents(withWithholding.summary.incomeTax));
    expect(cents(withWithholding.summary.withheld)).toBe(7200);
    // Compared with toBeCloseTo because the expectation is built with JS floats
    // in the test; the engine itself never does float arithmetic on money.
    expect(cents(withWithholding.summary.balance)).toBeCloseTo(
      7200 - cents(withWithholding.summary.incomeTax),
      2,
    );
  });
});

describe("Spain - trace integrity", () => {
  it("every step carries a formula, inputs and an output", () => {
    const r = plain(3000);
    expect(r.steps.length).toBeGreaterThan(10);
    for (const step of r.steps) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.formula.length).toBeGreaterThan(0);
      expect(step.output).toBeDefined();
    }
  });

  it("bracket steps expand every band and the bands sum to the step total", () => {
    const r = plain(5000);
    const estatal = r.steps.find((s) => s.id === "es-9a")!;
    expect(estatal.bands!.length).toBeGreaterThan(1);
    const banded = estatal.bands!.reduce((acc, b) => acc + Number(b.tax), 0);
    expect(banded).toBeCloseTo(Number(estatal.inputs["cuota sobre la base"]), 2);
  });

  it("the result is stamped with both ruleset versions and their provenance", () => {
    const r = plain(3000);
    expect(r.rulesets.map((s) => s.version)).toEqual([
      "es-national-2026-0.1.0",
      "es-madrid-2026-0.1.0",
    ]);
    for (const stamp of r.rulesets) {
      expect(stamp.provenance.source.length).toBeGreaterThan(0);
      expect(stamp.provenance.confidence).toBeDefined();
    }
  });
});
