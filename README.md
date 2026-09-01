# Multi-country personal income tax estimator

Thirty jurisdictions. A single-page, no-login, client-side estimator: pick a country, a region and a tax year, enter income month by month, and get a liability with a full step-by-step calculation trace.

**No income figure ever leaves the browser.** The engine is pure TypeScript bundled into the page; there is no API route, no database and no telemetry. The build output is fully static.

## Read this first

**No ruleset has been reconciled line by line against the legislation.** Figures were read from named sources in August 2026 — the official statute text where it could be fetched (Germany's §32a, the Dutch arbeidskorting table, Brazil's INSS schedule), PwC Worldwide Tax Summaries for most rate schedules, and secondary sources for a number of thresholds. Every file records what its source was, when it was read, and what still needs checking. The result page says so on screen. `tests/GOLDEN-TODO.md` lists exactly what to verify and where.

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

Every country gets its own pipeline, because these thirty genuinely differ in shape. A generic "subtract the allowance, then apply brackets" function is wrong for all of them.

| Country | What makes its pipeline its own |
| --- | --- |
| **Spain** | Applies the scales to the full base, applies them again to the mínimo personal y familiar, and subtracts the second result. At €26,050 with a €5,550 minimum the state cuota is `brackets(26,050) − brackets(5,550) = 2,463.00`, not `brackets(20,500) = 2,148.75`. |
| **Canada** | Tax on full income, then credits valued at the *lowest* rate. Alberta taxes its first bracket at 8% but still values credits at 10%, and Ontario charges a surtax on the tax remaining *after* credits. |
| **United States** | A second, wholly independent state computation on its own base. Social Security stops dead at the wage base while Medicare runs on and then *gains* a 0.9% surtax, so the contribution rate falls and then rises again. Texas has no computation at all. |
| **Hong Kong** | Computes the tax **twice** and charges the lower. Allowances are worth nothing once the standard rate binds, and the marginal rate *falls* from 17% to 15% at the crossover. |
| **France** | Divides taxable income by family parts, taxes that, multiplies back — then caps the saving per half-part, which needs the tax computed twice and compared. Only 6.8 of the 9.2 CSG points are deductible, so part of a contribution is itself taxed. |
| **Germany** | §32a is a **piecewise polynomial**, not a bracket table: the marginal rate climbs continuously from 14% to 42%. Then a solidarity surcharge with a Milderungszone, and church tax charged on the tax. |
| **UK** | The allowance is withdrawn at 50p per pound above £100,000, creating a 60% band no rate table shows. National Insurance is charged per *pay period* and its rate **falls** from 8% to 2%. Gift Aid extends the bands rather than reducing income. |
| **Ireland** | Three separate charges over three different bases. USC is a **cliff**: under €13,000 none at all, over it the whole income is charged. The PRSI rate changes on 1 October 2026. |
| **Italy** | An employment credit that tapers to nothing by €50,000, and a *trattamento integrativo* that is **paid** to the worker — so net tax genuinely goes below zero. Two local surcharges are charged on the whole income even when IRPEF is nil. |
| **Netherlands** | Two credits, both tapering on different schedules, which push the real marginal rate about thirteen points above the headline 37.56%. |
| **Portugal** | The statute applies a rate to the *whole* income and subtracts a fixed *parcela a abater*. The specific deduction is the **higher** of a fixed floor and your actual contributions, so for most employees the contributions are effectively not deducted. |
| **Austria** | The 13th and 14th salaries are a **second tax base**, taxed at a flat 6% after a €620 exemption and never entering the progression. |
| **Poland** | The tax-free amount is delivered as a PLN 3,600 reduction of the *tax*. The 9% health contribution is deliberately **non**-deductible. The pension cap is annual, so it bites mid-year. |
| **Czechia** | Taxes **gross pay**: contributions are not deductible at all. Social security stops at an annual cap while health insurance carries on. |
| **Denmark** | 8% comes off the top **first**, before any allowance, and every later tax is charged on the 92% that remains. Two bases then run in parallel, so one deduction reduces municipal tax but not bundskat. |
| **Norway** | Two taxes over two different bases at once: 22% on income *after* deductions, and a five-step bracket tax on **gross** income with no deductions at all. |
| **Japan** | An employment income deduction that is a formula and **flattens** above ¥8.5m, then a 2.1% surtax on the *tax* and a 10% inhabitant's tax on income assessed a year in arrears. |
| **China** | A flat ¥60,000 allowance and a rate with a quick deduction. Withholding is cumulative, so net pay falls through the year on an unchanged salary. |
| **South Korea** | A sharply regressive earned income deduction — 70% of the first tranche, 2% at the top — and a long-term care premium charged on the **health premium**, not on salary. |
| **Singapore** | One SGD 80,000 cap over the **sum** of all reliefs, so a high earner's last relief is worth nothing. Donations sit outside it, at 250% of the gift. |
| **India** | A rebate with marginal relief, then a surcharge with its own marginal relief, then 4% cess on both. Just above ₹12,00,000 the marginal rate is effectively 100%. |
| **Australia** | The Medicare levy is nil, then shaded in at 10% of the excess, then charged at 2% on the *whole* income. A non-refundable offset withdraws at two different rates. |
| **New Zealand** | No allowance and no tax-free threshold at all, and a credit that exists only inside a window between two incomes and is withdrawn inside it. |
| **Brazil** | Genuinely **twelve monthly computations**. The 2026 exemption is tested against *monthly* pay, so the same annual salary is taxed differently depending on how it was spread. |
| **Mexico** | A fixed quota plus a rate on the excess, as article 152 states it and as a Mexican payslip prints it. |
| **South Africa** | Taxes from the first rand at 18% and rebates the tax afterwards — which is why the threshold is exactly the rebate divided by the first rate. |
| **Türkiye** | The tax attributable to a minimum-wage salary is exempt for **every** employee, computed by running the same scale over a minimum-wage base and subtracting it. |
| **Bulgaria** | Flat 10% *after* contributions, so the marginal rate is 8.62% below the contribution ceiling and 10% above it. The ceiling changed on 1 August 2026. |
| **Kuwait**, **Saudi Arabia** | No personal income tax exists; the tax step is a citation, not a calculation. Contributions apply to nationals only, on ceilings computed from a narrower base than total pay. |

## Architecture

```
src/engine/      money (decimal.js, explicit rounding), currency table, bracket
                 evaluator, trace recorder, ruleset registry, input readers,
                 pipeline plumbing   — knows no tax law
src/adapters/    one file per country, each owning its own step order
rules/{cc}/{year}/  versioned rulesets with provenance, verification TODOs and
                 a list of what each does not model
```

Money is `Decimal` throughout; floats are never used for money. Rounding is an explicit parameter of every step — there is no bare `Math.round` in the engine. The currency table carries display precision, so the Kuwaiti dinar renders to three decimals, the yen and won to none, and Indian rupees group in lakhs, without special-casing at any call site.

**The marginal rate is measured, not looked up.** The whole pipeline runs again with a little more gross pay and the difference is divided by the increment. That is the only way to capture Spain's tapering work-income reduction, the UK's 60% band, India's marginal relief, Australia's Medicare shade-in and Hong Kong's *falling* marginal rate without hand-coding each one.

## Saving a PDF

After a calculation there is a **Save as PDF** action. It uses the browser's own print-to-PDF, so the document never leaves the machine and comes out as real vector text with selectable, copyable figures — no rasterising library, no server round trip, nothing that would weaken the privacy promise.

What prints is not the screen reflowed onto paper. `PrintableReport` is a separate document built for the job:

- every trace line **expanded** — formula, expanded bands, the note and the legal authority — because a collapsed accordion is useless on paper;
- a **schedule of what was entered**, restating the twelve monthly figures and the fields you filled in, so the sheet stands alone as evidence of its own inputs;
- the summary, the reviewer's notes, the legal notice and the full ruleset provenance including what is still unverified;
- A4 page setup, `break-inside: avoid` on each step so a line never splits across a page, and a document reference in the header.

The saved file is named from the jurisdiction and date — `estimate-of-liability-ES-2026-MADRID-2026-09-01.pdf` — rather than from the page title.

## The trace

Each step appends a `TraceStep` carrying its id, label, formula, inputs, output, legal reference and — for bracket steps — every expanded band. The user-facing explanation is rendered from those objects, so the words and the number come from the same source and cannot drift. No explanatory prose is written by hand anywhere.

## Monthly entry, annual assessment

Most of these countries assess annually, but the monthly grid is not decoration:

- **Contribution ceilings are monthly** in Spain, Germany, Austria, Denmark, Kuwait, Saudi Arabia, Hong Kong, Singapore, Türkiye, South Africa and Bulgaria, so twelve months of €4,000 and six months of €8,000 give different contributions on the same annual gross.
- **UK National Insurance is charged per pay period and never reconciled**, so a bonus month costs more NI than the same money spread evenly.
- **Rates change mid-year**: Bulgaria's ceiling rose on 1 August 2026, Ireland's PRSI rate rises on 1 October 2026.
- **Brazil is genuinely monthly**: its exemption is tested against monthly pay, so how the year was spread changes the tax.
- Dividing the annual liability by twelve and comparing it against what was withheld gives the refund or amount owing — usually the number people are actually after.

A blank month is a month with no income. A partial year is taxed on the actual total and is **never** annualised.

## Adding a jurisdiction

- **A US state, Italian region, Danish municipality or German Bundesland**: add an entry to the `regions` array in that country's single JSON file. No code change at all.
- **A Spanish comunidad or Canadian province**: copy an existing region file and register the import in `src/engine/registry.ts`. Those two keep one file per region because the region is their main axis of variation.
- **A new country**: add its code to `CountryCode`, write `src/adapters/{cc}.ts` with its own pipeline, and add it to `src/adapters/index.ts`. The union is exhaustive, so a missing adapter is a compile error — there is deliberately no generic fallback.

Form fields render from each ruleset's declared `inputSchema`, so a new jurisdiction's fields appear automatically.

## Tests

494 tests across seven files, including 333 property assertions run over 36 jurisdiction configurations.

Golden values are hand-derived from the ruleset figures, with the longhand arithmetic written out above each assertion. Property tests assert that tax is monotonically non-decreasing in income, that take-home never falls as gross rises, that the effective rate never exceeds the top effective rate, that tax + contributions + take-home reconstruct the gross exactly, and that every declared field carries help text.

Germany gets an extra structural check: the five tariff zones must join continuously, which a mistyped coefficient would break. Where a system contains a genuine cliff or a transfer — Ireland's USC threshold, Italy's *trattamento integrativo* — the property tests assert the **size** of the discontinuity rather than pretending it does not exist.

What the suite does **not** prove is that the rulesets hold the right numbers. See `tests/GOLDEN-TODO.md`.

## Deliberate exclusions

**Switzerland and Sweden were considered and left out.** Swiss cantonal and communal tariffs, and Sweden's *jobbskatteavdrag*, are material mechanisms that could not be pinned down from a citable source in this pass. Shipping either without them would produce a confidently wrong number, which is worse than an absent country. Austria and Czechia took their places. Both remain good candidates once the missing tables are in hand.

## Scope

Out of scope everywhere: self-employment and business income, capital gains, non-residents, joint filing, and mid-year changes of residence. The United States models the single filing status only. Each ruleset lists its own omissions — Ontario's LIFT credit, the Dutch 30% ruling, UK student loans, India's old regime, Mexico's subsidio para el empleo, Japan's 2026 basic-deduction supplement, Korea's earned income tax credit, and others — and the result page surfaces them.

## Legal

Every result page carries, in the body rather than a footer: *Estimate for informational purposes only. This is not tax advice. Figures are based on published rates for the selected year and do not account for all personal circumstances. Consult a qualified tax professional or the relevant tax authority before acting on this.*

The result also shows the ruleset versions, their source citations and their verification dates. The word "exact" is not used anywhere in the product.
