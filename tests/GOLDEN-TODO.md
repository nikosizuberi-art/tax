# Golden test coverage — what is and is not proven

## What the current suite proves

494 tests pass across seven files and thirty countries. They prove that:

- each pipeline runs in the order its jurisdiction actually requires;
- the arithmetic matches values derived **longhand from the ruleset figures**, written out in the comment above each assertion;
- the structural traps are handled — Spain's rate-scale subtraction, Canada's credits at the lowest rate and Ontario's surtax on tax, Hong Kong's lower-of-two computations, Germany's polynomial zones joining continuously, the UK's 60% band and per-period NI, France's quotient familial and its cap, Ireland's three bases and USC cliff, Italy's tapering credit and paid-out transfer, Austria's separate 6% base, Czechia's non-deductible contributions, Denmark's 8%-first ordering, Norway's two bases, Japan's flattening deduction, Korea's premium-on-a-premium, Brazil's genuinely monthly computation, South Africa's rebate-derived threshold, Türkiye's universal minimum-wage exemption, and the absence of any income tax in Kuwait and Saudi Arabia;
- monthly ceilings are applied monthly, annual ceilings annually, mid-year rate changes on the right months, and a partial year is never annualised;
- the invariants hold across 29 income points in 36 jurisdiction configurations.

## What the current suite does NOT prove

**No value here comes from a tax authority's own worked example.** Every "golden" number is derived from the ruleset JSON. If a rate in a ruleset is wrong, the test agrees with the wrong rate. The tests verify the *pipeline*; they do not verify the *inputs to the pipeline*.

## Source quality, by country

Read in August 2026. Ranked by how much weight the figures can bear.

| Confidence | Country | Source actually used |
| --- | --- | --- |
| **Statute text fetched directly** | Germany | §32a EStG at gesetze-im-internet.de, stating it applies from assessment year 2026. The five zones join continuously under test, which independently corroborates the coefficients. |
| **Authority table fetched directly** | Netherlands | The Belastingdienst's own 2026 arbeidskorting table. |
| **Table that reconciles internally** | Brazil | The 2026 INSS table reconciles exactly to the published maximum: 8,475.55 × 14% − 198.49 = 988.09. |
| **Reputable secondary, fetched** | Hong Kong, UK, France, Italy, Ireland, Portugal, Austria, Czechia, Denmark, Norway, Poland, Singapore, India, Australia, New Zealand, Japan, China, Korea, Mexico, South Africa, Türkiye, Bulgaria, Kuwait, Saudi Arabia, United States | PwC Worldwide Tax Summaries, the Tax Foundation for US federal and state tables, and national practitioner or payroll summaries for the rest. |
| **Transcribed from the build brief** | Spain (state scale), Canada (federal) | Supplied in the original specification, not independently fetched. |
| **Derived by indexation** | Spain (all four regional scales), Canada (Ontario, BC, Alberta) | Previous-year figures multiplied by each jurisdiction's published indexation factor. Still the weakest figures in the project. |

## Figures that were NOT confirmed by any source

These were carried from general knowledge because no source in the research pass gave them. Each one materially affects its country's result and should be treated as the first thing to check.

| Figure | File |
| --- | --- |
| Austrian social security rate (18.07%) and monthly ceiling (€6,450) | `rules/at/2026/national.json` |
| Austrian Verkehrsabsetzbetrag (€487) | `rules/at/2026/national.json` |
| Czech taxpayer credit (CZK 30,840) and contribution rates | `rules/cz/2026/national.json` |
| Korean earned income deduction rate schedule (only its KRW 20m cap was confirmed) | `rules/kr/2026/national.json` |
| Korean social insurance rates | `rules/kr/2026/national.json` |
| Japanese social insurance rates, and no ceilings applied | `rules/jp/2026/national.json` |
| Italian INPS employee rate (9.19%) | `rules/it/2026/national.json` |
| Italian regional and municipal surcharge rates, modelled as flat | `rules/it/2026/national.json` |
| French "other employee contributions" (11%), an approximation of a real payslip | `rules/fr/2026/national.json` |
| Portuguese specific deduction floor (derived from 8.54 × IAS) | `rules/pt/2026/national.json` |
| US Social Security wage base — the 2025 figure carried forward | `rules/us/2026/national.json` |
| Chinese IIT thresholds and quick deductions (corroborated by search, not by the STA) | `rules/cn/2026/national.json` |
| Brazilian monthly IRRF table bands | `rules/br/2026/national.json` |

## Where sources actively conflicted

- **Denmark.** PwC gives a single top tax of 7.5% above DKK 845,543. Danish reform summaries give mellemskat 7.5% above 641,200, topskat 7.5% above 777,900 and top-topskat 5% above 2,592,700. The reform figures are used. The employment allowance maximum was reported as both DKK 56,200 and DKK 63,300; the higher is used. **Confirm with Skattestyrelsen before relying on any Danish figure.**

## To close the gap before shipping

For each country, take the tax authority's own worked examples and add them as tests with the published result as the expected value:

- **Spain** — AEAT *Manual Práctico Renta*; cross-check a full return per region against Renta WEB.
- **Canada** — CRA **T4127**, Chapter 8, for Ontario, BC and Alberta.
- **United States** — IRS Publication 15-T and each state revenue department; confirm the SSA wage base.
- **France** — the impots.gouv.fr simulator, especially at the quotient familial cap and inside the décote.
- **Germany** — the BMF *Lohn- und Einkommensteuerrechner*, which implements §32a directly.
- **UK** — HMRC PAYE and Scottish rate examples; confirm the 2026/27 NI thresholds.
- **Ireland** — Revenue's own examples, especially at the USC exemption cliff.
- **Italy** — Agenzia delle Entrate, for the detrazione and the trattamento integrativo conditions.
- **Everywhere else** — the national authority's own calculator: Belastingdienst, Autoridade Tributária, BMF Austria, Finanční správa, Skattestyrelsen, Skatteetaten, NTA Japan, STA China, NTS Korea, IRAS, Inland Revenue NZ, Receita Federal, SAT Mexico, SARS, GİB Türkiye, NRA Bulgaria, PIFSS and GOSI.

Then set `provenance.verifiedOn` and change `confidence` to `"verified"` — one file at a time, only once its figures have actually been checked — and work through each ruleset's `verificationTodo` array.

## Known modelling omissions that make a figure clearly wrong

Each is recorded in the relevant ruleset's `omissions` and surfaced on the result page, but these are the ones that move a number the most:

| Omission | Effect |
| --- | --- |
| Mexico's subsidio para el empleo | Overstates tax at low incomes, sometimes to zero-vs-nonzero |
| Japan's 2026 income-dependent basic deduction supplement | Overstates tax for many taxpayers |
| Korea's earned income tax credit | Overstates tax for most employees |
| Portugal's mínimo de existência | Overstates tax at low incomes |
| Ontario's LIFT credit and BC's tax reduction | Overstate tax at low incomes |
| Sweden-style employment credits generally | Not applicable — Sweden is excluded for this reason |
| KiwiSaver, UK student loans, HELP repayments | Understate total deductions from pay |
| China's city-specific social insurance | Overstates taxable income unless the user enters their own figure |
