# Multi-country personal income tax estimator

Twelve jurisdictions. A single-page, no-login, client-side estimator: pick a country, a region and a tax year, enter income month by month, and get a liability with a full step-by-step calculation trace.

**No income figure ever leaves the browser.** The engine is pure TypeScript bundled into the page; there is no API route, no database and no telemetry. The build output is fully static.

## Read this first

**No ruleset has been reconciled line by line against the legislation.** Figures were read from named sources on 31 August 2026 — the official statute text where it could be fetched (Germany's §32a, the Dutch arbeidskorting table), PwC Worldwide Tax Summaries for most rate schedules, and secondary sources for a handful of thresholds. Every file records what its source was, when it was read, and what still needs checking. The result page says so. `tests/GOLDEN-TODO.md` lists exactly what to verify and where.

## Commands

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

## Why there is no shared bracket calculator

Every country gets its own pipeline, because these twelve genuinely differ in shape. A generic "subtract the allowance, then apply brackets" function is wrong for all of them:

| Country | What makes its pipeline its own |
| --- | --- |
| **Spain** | Applies the scales to the full base, applies them again to the mínimo personal y familiar, and subtracts the second result. At €26,050 with a €5,550 minimum the state cuota is `brackets(26,050) − brackets(5,550) = 2,463.00`, not `brackets(20,500) = 2,148.75`. |
| **Canada** | Tax on full income, then credits valued at the *lowest* rate. Alberta taxes its first bracket at 8% but still values credits at 10%, and Ontario charges a surtax on the tax remaining *after* credits. |
| **Hong Kong** | Computes the tax **twice** — progressive on income after allowances, standard rate on income *before* allowances — and charges the lower. Allowances are worth nothing once the standard rate binds, and the marginal rate *falls* from 17% to 15% at the crossover. |
| **Kuwait** | No personal income tax exists. The tax step is a citation, not a calculation. PIFSS applies to nationals only, on two rates with two different monthly ceilings. |
| **Bulgaria** | Flat 10% on pay *after* mandatory contributions, so the marginal rate is 8.62% below the contribution ceiling and 10% above it. The ceiling changed on 1 August 2026. |
| **Germany** | §32a is a **piecewise polynomial**, not a bracket table: the marginal rate climbs continuously from 14% to 42%. Then a solidarity surcharge with a Milderungszone, and church tax charged on the tax. |
| **UK** | The personal allowance is withdrawn at 50p per pound above £100,000, creating a 60% band no rate table shows. National Insurance is charged per *pay period* and its rate **falls** from 8% to 2%. Gift Aid extends the bands rather than reducing income. |
| **Netherlands** | Two credits, both tapering on different schedules, which push the real marginal rate about thirteen points above the headline 37.56%. |
| **Poland** | The tax-free amount is delivered as a PLN 3,600 reduction of the *tax*. The 9% health contribution is deliberately **not** deductible. The pension cap is annual, so it bites mid-year. |
| **Singapore** | One SGD 80,000 cap over the **sum** of all reliefs, so the last relief a high earner claims is worth nothing. Donations sit outside it, at 250% of the gift. |
| **India** | A rebate with marginal relief, then a surcharge with its own marginal relief, then 4% cess on both. Just above ₹12,00,000 the marginal rate is effectively 100%. |
| **Australia** | The Medicare levy is nil, then shaded in at 10% of the excess, then charged at 2% on the *whole* income. A non-refundable offset withdraws at two different rates. |

## Architecture

```
src/engine/      money (decimal.js, explicit rounding), currency table, bracket
                 evaluator, trace recorder, ruleset registry, input readers,
                 pipeline plumbing   — knows no tax law
src/adapters/    one file per country, each owning its own step order
rules/{cc}/{year}/  versioned rulesets with provenance, verification TODOs and
                 a list of what each does not model
```

Money is `Decimal` throughout; floats are never used for money. Rounding is an explicit parameter of every step — there is no bare `Math.round` in the engine. The currency table carries display precision, so the Kuwaiti dinar renders to three decimals and Indian rupees group in lakhs without special-casing at any call site.

**The marginal rate is measured, not looked up.** The whole pipeline runs again with a little more gross pay and the difference is divided by the increment. That is the only way to capture Spain's tapering work-income reduction, the UK's 60% band, India's marginal relief and Australia's Medicare shade-in without hand-coding each one.

## The trace

Each step appends a `TraceStep` carrying its id, label, formula, inputs, output, legal reference and — for bracket steps — every expanded band. The user-facing explanation is rendered from those objects, so the words and the number come from the same source and cannot drift. No explanatory prose is written by hand anywhere.

## Monthly entry, annual assessment

Every country here assesses annually, but the monthly grid is not decoration:

- **Contribution ceilings are monthly** in Spain, Germany, Kuwait, Hong Kong, Singapore and Bulgaria, so twelve months of €4,000 and six months of €8,000 give different contributions on the same annual gross.
- **UK National Insurance is charged per pay period and never reconciled**, so a bonus month costs more NI than the same money spread evenly. The app reproduces that.
- **Bulgaria's ceiling changed mid-year** (1 August 2026), so the same salary is capped differently across the year.
- Dividing the annual liability by twelve and comparing it against what was withheld gives the refund or amount owing — usually the number people actually want.

A blank month is a month with no income. A partial year is taxed on the actual total and is **never** annualised.

## Adding a jurisdiction

Add one JSON file and register its import:

- **A Spanish comunidad or Canadian province**: copy an existing region file in `rules/es/2026/` or `rules/ca/2026/` and register it in `src/engine/registry.ts`. Those two countries keep one file per region because the region is their main axis of variation.
- **Everywhere else**: one file per country-year with an inline `regions` array, registered via `registerGeneric` at the top of the country's adapter.
- **A new country**: add its code to `CountryCode`, write `src/adapters/{cc}.ts` with its own pipeline, and add it to `src/adapters/index.ts`. The union is exhaustive, so a missing adapter is a compile error — there is deliberately no generic fallback.

Form fields render from each ruleset's declared `inputSchema`, so a new jurisdiction's fields appear automatically. The static import is the only code a new *region* needs, because bundling JSON for a static client build requires it.

## Tests

268 tests: 24 Spain, 24 Canada, 20 Hong Kong/Kuwait/Bulgaria, 20 Germany/UK, 31 Netherlands/Poland/Singapore/India/Australia, and 149 property assertions across 18 jurisdiction configurations.

Golden values are hand-derived from the ruleset figures, with the longhand arithmetic written out above each assertion. Property tests assert that tax is monotonically non-decreasing in income, that take-home never falls as gross rises, that the effective rate never exceeds the top effective rate, that tax + contributions + take-home reconstruct the gross exactly, and that every declared field carries help text.

Germany gets an extra structural check: the five tariff zones must join continuously, which a mistyped coefficient would break.

What the suite does **not** prove is that the rulesets hold the right numbers. See `tests/GOLDEN-TODO.md`.

## Scope

Out of scope everywhere: self-employment and business income, capital gains, non-residents, joint filing, and mid-year changes of residence. Each ruleset lists its own omissions — Ontario's LIFT credit, the Dutch 30% ruling, UK student loans, India's old regime, Australia's HELP repayments, and others — and the result page surfaces them.

## Legal

Every result page carries, in the body rather than a footer: *Estimate for informational purposes only. This is not tax advice. Figures are based on published rates for the selected year and do not account for all personal circumstances. Consult a qualified tax professional or the relevant tax authority before acting on this.*

The result also shows the ruleset versions, their source citations and their verification dates. The word "exact" is not used anywhere in the product.
