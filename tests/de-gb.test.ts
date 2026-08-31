import { describe, it, expect } from "vitest";
import { deAdapter, tarif } from "../src/adapters/de";
import { gbAdapter } from "../src/adapters/gb";
import { input, perMonth, cents } from "./helpers";
import { Decimal } from "../src/engine/money";
import { loadGeneric } from "../src/engine/registry";
import type { FieldValue } from "../src/engine/types";

const de = (values: Record<string, FieldValue>, region = "uebrige-laender") =>
  deAdapter.compute(input("DE", region, values));
const gb = (values: Record<string, FieldValue>, region = "england-wales-ni") =>
  gbAdapter.compute(input("GB", region, values));
import type { CalcResult } from "../src/engine/types";
const step = (r: CalcResult, id: string) => r.steps.find((s) => s.id === id)!;

describe("Germany - the tariff is a polynomial, not a bracket table", () => {
  const rules = loadGeneric("DE", 2026) as unknown as { tariff: Parameters<typeof tarif>[1] };
  const t = (x: number) => tarif(new Decimal(x), rules.tariff).tax.toNumber();

  it("the five zones join continuously, which a wrong coefficient would break", () => {
    for (const edge of [12348, 17799, 69878, 277825]) {
      // Only the euro-rounding may differ across a boundary; a coefficient
      // error would open a visible gap here.
      expect(Math.abs(t(edge + 1) - t(edge))).toBeLessThanOrEqual(1);
    }
  });

  it("HAND-DERIVED: the zone 3 polynomial at a taxable income of 50,000", () => {
    // z = (50,000 - 17,799) / 10,000 = 3.2201
    // (173.10 x 3.2201 + 2,397) x 3.2201 + 1,034.87 = 10,548.33, floored to 10,548
    expect(t(50000)).toBe(10548);
  });

  it("HAND-DERIVED: zone 4 is the only genuinely linear stretch", () => {
    // 0.42 x 100,000 - 11,135.63 = 30,864.37, floored to 30,864
    expect(t(100000)).toBe(30864);
    // and the marginal rate there really is a flat 42 cents in the euro
    expect(t(100100) - t(100000)).toBe(42);
  });

  it("nothing is due within the Grundfreibetrag", () => {
    expect(t(12348)).toBe(0);
    expect(t(12349)).toBe(0);
    expect(t(20000)).toBeGreaterThan(0);
  });

  it("the marginal rate RISES continuously through the progression zones", () => {
    const marginals = [15000, 25000, 40000, 60000].map((x) => t(x + 100) - t(x));
    for (let i = 1; i < marginals.length; i++) {
      expect(marginals[i]).toBeGreaterThan(marginals[i - 1]);
    }
    // and never leaves the statutory 14% to 42% range in those zones
    expect(marginals[0]).toBeGreaterThanOrEqual(14);
    expect(marginals[marginals.length - 1]).toBeLessThanOrEqual(42);
  });
});

describe("Germany - full pipeline", () => {
  it("social insurance uses two different monthly ceilings", () => {
    const r = de({ grossMonthly: perMonth(10000) });
    const s = step(r, "de-2");
    // Pension and unemployment cap at 8,450 a month, health and care at 5,812.50
    // 9.3% x 8,450 x 12 = 9,430.20 ; 1.3% x 8,450 x 12 = 1,318.20
    expect(Number(s.inputs["Rentenversicherung"])).toBeCloseTo(9430.2, 2);
    expect(Number(s.inputs["Arbeitslosenversicherung"])).toBeCloseTo(1318.2, 2);
    // health 8.75% x 5,812.50 x 12 = 6,103.13 (rounded per month)
    expect(Number(s.inputs["Krankenversicherung"])).toBeCloseTo(6103.08, 1);
  });

  it("the childless surcharge is borne by the employee alone", () => {
    const withChild = de({ grossMonthly: perMonth(4000) });
    const childless = de({ grossMonthly: perMonth(4000), childless: true });
    // 0.6% of 48,000 = 288
    expect(
      cents(childless.summary.socialContributions) - cents(withChild.summary.socialContributions),
    ).toBeCloseTo(288, 1);
  });

  it("no solidarity surcharge is due below the Freigrenze, and it phases in above it", () => {
    const modest = de({ grossMonthly: perMonth(5000) });
    expect(Number(step(modest, "de-7").output)).toBe(0);

    const high = de({ grossMonthly: perMonth(20000) });
    const soli = Number(step(high, "de-7").output);
    const est = Number(step(high, "de-6").output);
    expect(soli).toBeGreaterThan(0);
    // Inside or above the Milderungszone the surcharge never exceeds 5.5%
    expect(soli).toBeLessThanOrEqual(est * 0.055 + 0.01);
  });

  it("church tax is charged on the tax, and the state sets the rate", () => {
    const none = de({ grossMonthly: perMonth(6000) });
    const bavaria = de({ grossMonthly: perMonth(6000), churchMember: true }, "bayern");
    const elsewhere = de({ grossMonthly: perMonth(6000), churchMember: true });
    const est = Number(step(none, "de-6").output);
    expect(Number(step(bavaria, "de-8").output)).toBeCloseTo(est * 0.08, 2);
    expect(Number(step(elsewhere, "de-8").output)).toBeCloseTo(est * 0.09, 2);
    expect(cents(bavaria.summary.incomeTax)).toBeLessThan(cents(elsewhere.summary.incomeTax));
  });

  it("the Arbeitnehmer-Pauschbetrag applies unless actual expenses beat it", () => {
    const standard = de({ grossMonthly: perMonth(4000) });
    const small = de({ grossMonthly: perMonth(4000), werbungskosten: "500" });
    const large = de({ grossMonthly: perMonth(4000), werbungskosten: "3000" });
    expect(Number(step(standard, "de-3").output)).toBe(1230);
    expect(Number(step(small, "de-3").output)).toBe(1230);
    expect(Number(step(large, "de-3").output)).toBe(3000);
    expect(cents(large.summary.incomeTax)).toBeLessThan(cents(standard.summary.incomeTax));
  });

  it("zero income produces zero tax and zero contributions", () => {
    const r = de({ grossMonthly: perMonth(0) });
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(cents(r.summary.socialContributions)).toBe(0);
  });
});

describe("United Kingdom - allowance taper and per-period National Insurance", () => {
  it("HAND-DERIVED: GBP 60,000 in England", () => {
    // Personal allowance 12,570 in full; taxable 47,430
    // 37,700 x 20% = 7,540 ; 9,730 x 40% = 3,892  => 11,432
    // NI: monthly pay 5,000 is above the 4,189 upper limit, so
    //     8% x (4,189 - 1,048) = 251.28 and 2% x 811 = 16.22 => 267.50 a month
    //     267.50 x 12 = 3,210.00
    const r = gb({ grossMonthly: perMonth(5000) });
    expect(Number(step(r, "gb-5").output)).toBe(12570);
    expect(Number(step(r, "gb-6").output)).toBe(47430);
    expect(cents(r.summary.incomeTax)).toBe(11432);
    expect(cents(r.summary.socialContributions)).toBe(3210);
  });

  it("HAND-DERIVED: GBP 150,000 loses the allowance entirely", () => {
    // Allowance nil above 125,140. Taxable = 150,000
    // 37,700 x 20% = 7,540 | 87,440 x 40% = 34,976 | 24,860 x 45% = 11,187
    // => 53,703
    const r = gb({ grossMonthly: perMonth(12500) });
    expect(Number(step(r, "gb-5").output)).toBe(0);
    expect(cents(r.summary.incomeTax)).toBe(53703);
  });

  it("the 60% band exists between GBP 100,000 and GBP 125,140", () => {
    const inside = gb({ grossMonthly: perMonth(110000 / 12) });
    expect(inside.summary.marginalRate.toNumber()).toBeCloseTo(0.6, 3);
    expect(inside.warnings.join(" ")).toContain("60%");

    // Either side of the band the marginal rate is the ordinary 40% and 45%.
    expect(gb({ grossMonthly: perMonth(90000 / 12) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.4,
      3,
    );
    expect(gb({ grossMonthly: perMonth(140000 / 12) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.45,
      3,
    );
  });

  it("Scotland taxes the same salary differently, and harder at the top", () => {
    const englandTax = cents(gb({ grossMonthly: perMonth(5000) }).summary.incomeTax);
    const scotlandTax = cents(gb({ grossMonthly: perMonth(5000) }, "scotland").summary.incomeTax);
    expect(scotlandTax).not.toBe(englandTax);
    expect(scotlandTax).toBeGreaterThan(englandTax);

    // Scottish top rate is 48% rather than 45%
    const scotTop = gb({ grossMonthly: perMonth(300000 / 12) }, "scotland");
    expect(scotTop.summary.marginalRate.toNumber()).toBeCloseTo(0.48, 3);
  });

  it("the Scottish starter rate makes a low earner slightly better off than in England", () => {
    const scotland = gb({ grossMonthly: perMonth(1200) }, "scotland");
    const england = gb({ grossMonthly: perMonth(1200) });
    expect(cents(scotland.summary.incomeTax)).toBeLessThan(cents(england.summary.incomeTax));
  });

  it("National Insurance is charged per pay period and is never smoothed", () => {
    // The same GBP 60,000 paid evenly, or half of it in one bonus month.
    const even = gb({ grossMonthly: perMonth(5000) });
    const lumpy = gb({
      grossMonthly: [
        "30000",
        ...Array(11).fill(String(30000 / 11)),
      ] as unknown as FieldValue as string[],
    });
    expect(cents(even.summary.annualGross)).toBeCloseTo(cents(lumpy.summary.annualGross), 0);
    // Income tax is annual, so it is unchanged; NI is not, so it falls.
    expect(cents(lumpy.summary.incomeTax)).toBeCloseTo(cents(even.summary.incomeTax), 0);
    expect(cents(lumpy.summary.socialContributions)).toBeLessThan(
      cents(even.summary.socialContributions),
    );
  });

  it("the National Insurance rate FALLS above the upper earnings limit", () => {
    const belowUel = gb({ grossMonthly: perMonth(3000) });
    const aboveUel = gb({ grossMonthly: perMonth(6000) });
    const marginalNiBelow =
      cents(gb({ grossMonthly: perMonth(3100) }).summary.socialContributions) -
      cents(belowUel.summary.socialContributions);
    const marginalNiAbove =
      cents(gb({ grossMonthly: perMonth(6100) }).summary.socialContributions) -
      cents(aboveUel.summary.socialContributions);
    expect(marginalNiBelow).toBeCloseTo(96, 0); // 8% of 1,200 a year
    expect(marginalNiAbove).toBeCloseTo(24, 0); // 2% of 1,200 a year
  });

  it("Gift Aid extends the bands rather than reducing income", () => {
    const plain = gb({ grossMonthly: perMonth(5000) });
    const withGift = gb({ grossMonthly: perMonth(5000), giftAid: "1000" });
    // Taxable income is unchanged...
    expect(Number(step(withGift, "gb-6").output)).toBe(Number(step(plain, "gb-6").output));
    // ...but 1,250 of gross donation moves from 40% to 20%, worth 250.
    expect(cents(plain.summary.incomeTax) - cents(withGift.summary.incomeTax)).toBeCloseTo(250, 2);
  });

  it("zero income produces zero tax and zero National Insurance", () => {
    const r = gb({ grossMonthly: perMonth(0) });
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(cents(r.summary.socialContributions)).toBe(0);
  });
});
