import { describe, it, expect } from "vitest";
import { hkAdapter } from "../src/adapters/hk";
import { kwAdapter } from "../src/adapters/kw";
import { bgAdapter } from "../src/adapters/bg";
import { input, perMonth, cents } from "./helpers";
import type { FieldValue } from "../src/engine/types";

const hk = (values: Record<string, FieldValue>) => hkAdapter.compute(input("HK", "hk", values));
const kw = (values: Record<string, FieldValue>) => kwAdapter.compute(input("KW", "kw", values));
const bg = (values: Record<string, FieldValue>) => bgAdapter.compute(input("BG", "bg", values));
import type { CalcResult } from "../src/engine/types";
const step = (r: CalcResult, id: string) => r.steps.find((s) => s.id === id)!;

describe("Hong Kong - the lower of two computations", () => {
  it("HAND-DERIVED: HKD 600,000 - the progressive computation wins", () => {
    // MPF: pay of 50,000 a month exceeds the 30,000 maximum relevant income,
    //      so 5% x 30,000 = 1,500 a month = 18,000, exactly the deduction cap.
    // Net income        = 600,000 - 18,000 = 582,000
    // Net chargeable    = 582,000 - 145,000 = 437,000
    // Progressive: 50,000x2% = 1,000 | 50,000x6% = 3,000 | 50,000x10% = 5,000
    //              | 50,000x14% = 7,000 | 237,000x17% = 40,290  => 56,290
    // Standard   : 582,000 x 15% = 87,300
    // Payable    = min(56,290, 87,300) = 56,290
    const r = hk({ grossMonthly: perMonth(50000) });
    expect(cents(r.summary.socialContributions)).toBe(18000);
    expect(Number(step(r, "hk-4").output)).toBe(582000);
    expect(Number(step(r, "hk-6").output)).toBe(437000);
    expect(Number(step(r, "hk-7").output)).toBe(56290);
    expect(Number(step(r, "hk-8").output)).toBe(87300);
    expect(cents(r.summary.incomeTax)).toBe(56290);
    expect(cents(r.summary.takeHome)).toBe(525710);
  });

  it("HAND-DERIVED: HKD 3,000,000 - the standard rate caps the bill", () => {
    // Net income     = 3,000,000 - 18,000 = 2,982,000
    // Net chargeable = 2,982,000 - 145,000 = 2,837,000
    // Progressive: 16,000 + 2,637,000 x 17% = 464,290
    // Standard   : 2,982,000 x 15% = 447,300  <- lower, so it applies
    const r = hk({ grossMonthly: perMonth(250000) });
    expect(Number(step(r, "hk-7").output)).toBe(464290);
    expect(Number(step(r, "hk-8").output)).toBe(447300);
    expect(cents(r.summary.incomeTax)).toBe(447300);
    expect(r.warnings.join(" ")).toContain("standard rate computation");
  });

  it("allowances are worth nothing once the standard rate binds", () => {
    // At HKD 10,000,000 the standard rate wins even after three child
    // allowances: net income 9,982,000 gives standard tax of 1,547,120, while
    // the progressive computation is 1,654,290 with the basic allowance alone
    // and still 1,582,890 with three children on top. The allowance is real but
    // it buys nothing, because it never enters the computation that applies.
    const noChildren = hk({ grossMonthly: perMonth(10000000 / 12) });
    const threeChildren = hk({ grossMonthly: perMonth(10000000 / 12), children: 3 });
    expect(Number(step(threeChildren, "hk-5").output)).toBe(145000 + 3 * 140000);
    expect(cents(threeChildren.summary.incomeTax)).toBe(cents(noChildren.summary.incomeTax));

    // At HKD 3,000,000, by contrast, three children flip the answer back to the
    // progressive computation and DO reduce the bill - the crossover moves with
    // your allowances, which is why both computations have to be run every time.
    const midStandard = hk({ grossMonthly: perMonth(250000) });
    const midWithChildren = hk({ grossMonthly: perMonth(250000), children: 3 });
    expect(cents(midWithChildren.summary.incomeTax)).toBeLessThan(
      cents(midStandard.summary.incomeTax),
    );

    // At a middling income the same three children are worth real money.
    const midNone = hk({ grossMonthly: perMonth(50000) });
    const midThree = hk({ grossMonthly: perMonth(50000), children: 3 });
    expect(cents(midThree.summary.incomeTax)).toBeLessThan(cents(midNone.summary.incomeTax));
  });

  it("the marginal rate FALLS from 17% to 15% where the standard rate takes over", () => {
    expect(hk({ grossMonthly: perMonth(50000) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.17,
      4,
    );
    expect(hk({ grossMonthly: perMonth(250000) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.15,
      4,
    );
  });

  it("the second tier of the standard rate applies above HKD 5 million of net income", () => {
    const r = hk({ grossMonthly: perMonth(800000) });
    const bands = r.steps.find((s) => s.id === "hk-8")!.bands!;
    expect(bands.length).toBe(2);
    expect(Number(bands[1].rate)).toBe(0.16);
  });

  it("no MPF is due in a month below the minimum relevant income", () => {
    // 6,000 a month is below the 7,100 minimum, so no employee contribution.
    expect(cents(hk({ grossMonthly: perMonth(6000) }).summary.socialContributions)).toBe(0);
    // 10,000 a month is above it: 5% x 10,000 x 12 = 6,000.
    expect(cents(hk({ grossMonthly: perMonth(10000) }).summary.socialContributions)).toBe(6000);
  });

  it("zero income produces zero tax", () => {
    const r = hk({ grossMonthly: perMonth(0) });
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(cents(r.summary.socialContributions)).toBe(0);
  });

  it("donations are limited to 35% of income after the other deductions", () => {
    const r = hk({ grossMonthly: perMonth(50000), donations: "500000" });
    // 35% x (600,000 - 18,000) = 203,700
    expect(Number(step(r, "hk-3").inputs["donations"])).toBe(203700);
    expect(r.warnings.join(" ")).toContain("35%");
  });
});

describe("Kuwait - no personal income tax", () => {
  it("an expatriate pays nothing at all: gross equals take-home", () => {
    const r = kw({ grossMonthly: perMonth(3000), nationality: "expatriate" });
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(cents(r.summary.socialContributions)).toBe(0);
    expect(cents(r.summary.takeHome)).toBe(36000);
    expect(r.summary.effectiveRateOnGross.toNumber()).toBe(0);
    expect(r.summary.marginalRate.toNumber()).toBe(0);
  });

  it("HAND-DERIVED: a Kuwaiti national on KWD 3,000 a month pays PIFSS on two ceilings", () => {
    // Basic:         8% x min(3,000, 2,750) = 220.000 a month => 2,640.000
    // Supplementary: 2.5% x min(3,000, 1,500) = 37.500 a month =>   450.000
    // Total 3,090.000, and still no income tax.
    const r = kw({ grossMonthly: perMonth(3000), nationality: "kuwaiti" });
    expect(cents(r.summary.socialContributions)).toBe(3090);
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(cents(r.summary.takeHome)).toBe(32910);
  });

  it("the income tax step is a citation, not a calculation", () => {
    const r = kw({ grossMonthly: perMonth(100000), nationality: "kuwaiti" });
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(step(r, "kw-3").formula).toContain("no personal income tax");
  });

  it("contributions stop rising above the monthly ceilings", () => {
    const at = kw({ grossMonthly: perMonth(2750), nationality: "kuwaiti" });
    const above = kw({ grossMonthly: perMonth(9000), nationality: "kuwaiti" });
    expect(cents(above.summary.socialContributions)).toBe(cents(at.summary.socialContributions));
  });

  it("the dinar is handled to three decimal places", () => {
    const r = kw({ grossMonthly: perMonth("1234.567"), nationality: "kuwaiti" });
    expect(r.summary.annualGross.toString()).toBe("14814.804");
  });
});

describe("Bulgaria - flat rate on income after contributions", () => {
  it("HAND-DERIVED: EUR 2,000 a month, below the ceiling all year", () => {
    // Contributions: 2,000 x 13.78% = 275.60 a month => 3,307.20
    // Base:          24,000 - 3,307.20 = 20,692.80
    // Tax:           10% x 20,692.80 = 2,069.28
    const r = bg({ grossMonthly: perMonth(2000) });
    expect(cents(r.summary.socialContributions)).toBe(3307.2);
    expect(Number(step(r, "bg-3").output)).toBe(20692.8);
    expect(cents(r.summary.incomeTax)).toBe(2069.28);
    expect(cents(r.summary.takeHome)).toBe(18623.52);
  });

  it("HAND-DERIVED: the ceiling change on 1 August 2026 splits the year in two", () => {
    // Jan-Jul: base 2,111.64 -> 290.98 a month x 7 = 2,036.86
    // Aug-Dec: base 2,300.00 -> 316.94 a month x 5 = 1,584.70
    // Total 3,621.56; base 36,000 - 3,621.56 = 32,378.44; tax 3,237.84
    const r = bg({ grossMonthly: perMonth(3000) });
    expect(cents(r.summary.socialContributions)).toBe(3621.56);
    expect(Number(step(r, "bg-3").output)).toBe(32378.44);
    expect(cents(r.summary.incomeTax)).toBe(3237.84);
  });

  it("the same annual pay costs more if it falls after the ceiling rose", () => {
    const early = bg({ grossMonthly: [...Array(7).fill("6000"), ...Array(5).fill(null)] });
    const late = bg({ grossMonthly: [...Array(7).fill(null), ...Array(5).fill("8400")] });
    expect(cents(early.summary.annualGross)).toBe(42000);
    expect(cents(late.summary.annualGross)).toBe(42000);
    // Both are capped every month, but the later cap is higher, so contributions differ.
    expect(cents(late.summary.socialContributions)).not.toBe(
      cents(early.summary.socialContributions),
    );
  });

  it("there is no tax-free allowance: even a very small income is taxed", () => {
    const r = bg({ grossMonthly: perMonth(100) });
    expect(cents(r.summary.incomeTax)).toBeGreaterThan(0);
    expect(r.summary.effectiveIncomeTaxRate.toNumber()).toBeCloseTo(0.0862, 3);
  });

  it("child relief reduces the base, not the tax", () => {
    const none = bg({ grossMonthly: perMonth(2000) });
    const one = bg({ grossMonthly: perMonth(2000), children: 1 });
    const two = bg({ grossMonthly: perMonth(2000), children: 2 });
    expect(Number(step(one, "bg-4").output)).toBe(3067.75);
    expect(Number(step(two, "bg-4").output)).toBe(6135.5);
    // Relief of 3,067.75 at 10% is worth 306.775 of tax, which lands on
    // 306.77 once the tax line itself is rounded half-up to the cent
    // (2,069.28 - 1,762.51). Rounding happens at the tax, not at the relief.
    expect(cents(none.summary.incomeTax) - cents(one.summary.incomeTax)).toBeCloseTo(306.77, 2);
  });

  it("child relief cannot take the base below zero", () => {
    const r = bg({ grossMonthly: perMonth(200), children: 3 });
    expect(cents(r.summary.incomeTax)).toBe(0);
    expect(Number(step(r, "bg-5").output)).toBe(0);
  });

  it("the marginal rate is under 10% below the ceiling and 10% above it", () => {
    expect(bg({ grossMonthly: perMonth(1500) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.0862,
      3,
    );
    expect(bg({ grossMonthly: perMonth(5000) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.1,
      3,
    );
  });
});
