# Open questions

Answers still needed from the owner. Until then, each item runs on the default shown, and every default is an admin setting (**Settings** screen) unless marked otherwise. Confirmed answers are recorded in `docs/00-phase0-proposal.md` §6–§13.

## Money (affects amounts)

| # | Question | Default in use | Where |
|---|---|---|---|
| 1 | Cashout: the spec asks for a discount (fixed amount or % of remaining principal). The owner said "no discounts, fees or minimums" (round 2). Is that final? | No discount: payoff = contract price − net amount paid | `src/lib/rto.ts` |
| 2 | Investor share: the spec lists "% of collections", "fixed monthly" and "net after expenses", plus a management fee. The owner confirmed one formula: 22 × daily boundary − the driver's monthly RTO amortization, no split. Do any investors need a different model or a management fee? | Owner formula for every investor | `investors.boundary_days` |
| 3 | Commissions on client applications (LTFRB PA/CPC, platform activation): what rate or fixed amount per service? Only the driver referral rule is confirmed (10% of the down payment, after 1 month). | Rule table ships empty (Phase 7) | Commission rules |
| 4 | Payroll: allowances or commissions for office staff? | None | Payroll |
| 5 | Who approves cashouts, large expenses and payroll? What amount counts as a "large" expense? | Owner/admin or finance may approve | Roles |

## Operations (no effect on amounts)

| # | Question | Default in use | Setting |
|---|---|---|---|
| 6 | Flag a driver after how many unpaid boundary days in a row? | 3 | `alerts.consecutive_unpaid_days` |
| 7 | Flag a driver whose total balance reaches how much? | ₱5,000.00 | `alerts.balance_threshold_centavos` |
| 8 | Warn how many days before a licence expires? | 30 | `alerts.license_expiry_days` |
| 9 | Quiet hours for reminders? | 21:00–07:00 Manila | `reminders.quiet_hours` |
| 10 | How many payment proofs may a driver have waiting at once? | 5 | `portal.max_pending_proofs` |
| 11 | SMS gateway: which aggregator (Semaphore, M360, Globe Labs…) and what budget per SMS? Until then, reminders are sent by hand from staff phones. | Manual sending | `messaging.mode` |
| 12 | Brand colours, logo and final landing-page copy. | Placeholder theme | Phase 7 |
| 13 | Number of drivers and vehicles today, and expected in 12 months. | Sized for 500 drivers | — |
| 14 | School page (`/school`): still wanted? Course details? | Placeholder, marked TODO | Website editor |
| 15 | Website copy: the requirement lists per service are generic placeholders. Please confirm the real LTFRB PA/CPC, activation and vehicle program requirements. | Generic lists | Website editor |
| 16 | Company address, phone and email for the website footer and receipts. | Empty | `company.profile` |
| 17 | Facebook Lead Ads: create a Meta app, pass app review for `leads_retrieval`, and give us the app secret and a page access token. | Off | `crm.meta_lead_ads_enabled` + `META_*` env |
| 18 | Should new website leads be notified by SMS or email as well (needs a provider)? | In-app only | — |

## Where the spec and the owner disagree

The owner's answers win, and the spec items below were deliberately **not** built. Tell us if any should change.

- **Non-charge days.** The spec has coding days, days off and maintenance days. Owner: every day is charged except regular holidays.
- **Late penalties.** Owner: none (`collections.penalties_enabled = false`).
- **Payment allocation.** The spec has one pool, paid oldest charge first. Owner: the collector splits each payment across boundary, amortization and charges. Oldest-first applies within each account.
- **RTO frequency.** The spec allows daily, weekly or monthly. Owner: fixed monthly, no interest, 60 months.
- **Driver login.** The spec uses an OTP by SMS. Owner: mobile number + password, because there is no SMS gateway yet.
