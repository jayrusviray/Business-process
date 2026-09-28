import { and, eq, like, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { chargeRuns, driverAccounts, drivers, employees, investors, vehicles } from "@/db/schema";
import { addDays, addMonths, daysBetween, type IsoDate } from "@/lib/dates";
import { pesos, ZERO, type Centavos } from "@/lib/money";
import { findOrCreateClient, createApplication, setApplicationStatus } from "../applications/service";
import { createLead } from "../crm/leads";
import { postBoundaryCharges } from "../money/charges";
import { MoneyRuleError } from "../money/errors";
import { assignVehicle, startBoundaryPlan } from "../money/fleet";
import { createRemittance, postDriverCharge, recordPayment } from "../money/payments";
import { createRtoContract, postAmortizationCharges } from "../money/rto";
import { setVehicleInvestor } from "../office/investors";

/**
 * Demo data for a development database (never production): 20 drivers, 15
 * vehicles (5 EV), boundary and RTO contracts, 60 days of daily charges and
 * realistic payments (full, partial and missed days), leads, applications,
 * 5 employees and 2 investors with vehicles.
 *
 * History is produced by the real services, never by hand-written ledger rows:
 * plans start 60 days back (that date is passed as "today"), charges are
 * posted day by day with postBoundaryCharges, and payments are recorded on
 * their past business dates. Every transaction goes through `runTx`, which
 * must be a system transaction (withSystemTx-style, RLS bypassed).
 * Auth users are NOT created here: payments need an existing staff profile
 * (collector), e.g. from `npm run db:seed:dev`.
 */
export const DEMO_MARK = "[demo]";
export const DEMO_DAYS = 60;

export type RunTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export type DemoSummary = {
  drivers: number;
  vehicles: number;
  contracts: number;
  payments: number;
  charges: number;
  leads: number;
  applications: number;
  employees: number;
  investors: number;
  from: IsoDate;
  to: IsoDate;
};

/** Small deterministic PRNG (mulberry32) so every run produces the same history. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Juan", "Pedro", "Ramil", "Jerome", "Arnel", "Christian", "Mark", "Joel", "Rodel", "Noel", "Dennis", "Ronald", "Jayson", "Michael", "Allan", "Rey", "Edwin", "Ryan", "Carlo", "Benjie"];
const LAST = ["Dela Cruz", "Santos", "Reyes", "Garcia", "Bautista", "Mendoza", "Villanueva", "Ramos", "Aquino", "Castillo", "Navarro", "Torres", "Flores", "Gonzales", "Lopez", "Rivera", "De Leon", "Pascual", "Salazar", "Mercado"];
const VEHICLES: { make: string; model: string; powertrain: "ev" | "ice" | "hybrid"; cost: number }[] = [
  { make: "BYD", model: "e6", powertrain: "ev", cost: 1_650_000 },
  { make: "BYD", model: "Dolphin", powertrain: "ev", cost: 1_398_000 },
  { make: "BYD", model: "e6", powertrain: "ev", cost: 1_650_000 },
  { make: "Nissan", model: "Leaf", powertrain: "ev", cost: 1_900_000 },
  { make: "BYD", model: "Dolphin", powertrain: "ev", cost: 1_398_000 },
  { make: "Toyota", model: "Vios", powertrain: "ice", cost: 780_000 },
  { make: "Toyota", model: "Vios", powertrain: "ice", cost: 780_000 },
  { make: "Toyota", model: "Vios", powertrain: "ice", cost: 780_000 },
  { make: "Mitsubishi", model: "Mirage G4", powertrain: "ice", cost: 720_000 },
  { make: "Mitsubishi", model: "Mirage G4", powertrain: "ice", cost: 720_000 },
  { make: "Nissan", model: "Almera", powertrain: "ice", cost: 890_000 },
  { make: "Toyota", model: "Wigo", powertrain: "ice", cost: 610_000 },
  { make: "Honda", model: "City", powertrain: "ice", cost: 960_000 },
  { make: "Toyota", model: "Corolla Cross", powertrain: "hybrid", cost: 1_600_000 },
  { make: "Suzuki", model: "Dzire", powertrain: "ice", cost: 700_000 },
];

type DemoDriver = {
  id: string;
  rate: Centavos;
  /** Probability of paying the day in full; the rest is split between partial and missed days. */
  reliability: number;
  boundaryAccount: string;
  amortAccount: string | null;
  monthly: Centavos;
  suspendOn: IsoDate | null;
};

async function staff(tx: Tx) {
  const rows = await tx.execute<{ id: string; role: string }>(sql`
    SELECT ur.user_id AS id, ur.role::text AS role FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id WHERE p.status = 'active'
    ORDER BY p.created_at, ur.user_id`);
  const withRole = (...r: string[]) => [...new Set(rows.filter((x) => r.includes(x.role)).map((x) => x.id))];
  const collectors = withRole("operations").length ? withRole("operations") : withRole("finance", "owner_admin");
  return { collectors, receivers: withRole("finance", "owner_admin"), sales: withRole("sales")[0] ?? null };
}

/** Seeds the demo data. `today` is the last day of history (default: the business date today). */
export async function seedDemo(runTx: RunTx, opts: { today: IsoDate }): Promise<DemoSummary> {
  const today = opts.today;
  const start = addDays(today, -DEMO_DAYS);
  const rand = prng(20260927);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

  // 1. Fleet, people and contracts, as of the first day of history.
  const setup = await runTx(async (tx) => {
    const [already] = await tx.select({ id: drivers.id }).from(drivers).where(like(drivers.notes, `${DEMO_MARK}%`)).limit(1);
    if (already) throw new MoneyRuleError("Demo data is already in this database.");
    const people = await staff(tx);
    if (people.collectors.length === 0) {
      throw new MoneyRuleError("No active staff user to act as collector. Create users first (npm run db:seed:dev -- --yes).");
    }

    const vehicleIds: string[] = [];
    for (const [i, v] of VEHICLES.entries()) {
      const [row] = await tx
        .insert(vehicles)
        .values({
          plateNo: `DMO ${1001 + i}`,
          make: v.make,
          model: v.model,
          year: 2021 + (i % 4),
          color: pick(["White", "Silver", "Black", "Gray", "Blue", "Red"]),
          powertrain: v.powertrain,
          region: i % 5 === 4 ? "Laguna" : "NCR",
          platforms: ["inDrive"],
          acquisitionCostCentavos: pesos(v.cost),
          acquiredOn: addDays(start, -400 - i * 20),
          orcrExpiresOn: addDays(today, 20 + i * 25),
          insuranceExpiresOn: addDays(today, 45 + i * 20),
          fundingSource: i === 5 || i === 6 ? "financed" : "company",
          notes: `${DEMO_MARK} demo vehicle`,
        })
        .returning({ id: vehicles.id });
      vehicleIds.push(row.id);
    }

    const list: DemoDriver[] = [];
    let contracts = 0;
    for (let i = 0; i < 20; i++) {
      // 0–14 drive a vehicle; 15 active without vehicle; 16 suspended mid-way; 17–18 applicants; 19 terminated.
      const status = i === 17 || i === 18 ? "applicant" : i === 19 ? "terminated" : "active";
      const [d] = await tx
        .insert(drivers)
        .values({
          firstName: FIRST[i],
          lastName: LAST[i],
          phone: `0917${String(9000001 + i)}`,
          address: pick(["Quezon City", "Pasig", "Marikina", "Taguig", "Caloocan", "Makati", "Manila"]),
          licenseNo: `N0${1 + (i % 9)}-${20 + i}-${String(100000 + i * 7919).slice(0, 6)}`,
          licenseExpiry: addDays(today, i === 3 ? 12 : 200 + i * 30),
          emergencyContactName: `${pick(["Maria", "Rosa", "Liza", "Ana"])} ${LAST[i]}`,
          emergencyContactPhone: `0918${String(8000001 + i)}`,
          status,
          preferredLanguage: i % 4 === 0 ? "en" : "taglish",
          notes: `${DEMO_MARK} demo driver`,
        })
        .returning({ id: drivers.id });
      if (status !== "active") continue;
      const isRto = i < 5;
      const rate = pesos(isRto ? 700 : pick([650, 750, 800, 850, 900, 1000]));
      await startBoundaryPlan(tx, { driverId: d.id, programType: isRto ? "rto" : "boundary", dailyRate: rate, effectiveFrom: start, notes: DEMO_MARK }, start);
      if (i < 15) await assignVehicle(tx, { driverId: d.id, vehicleId: vehicleIds[i], startDate: start, reason: DEMO_MARK });
      if (i % 3 === 0) await postDriverCharge(tx, { driverId: d.id, kind: "deposit_charge", amount: pesos(5000), dueDate: start, memo: "Non-refundable deposit" });
      let amortAccount: string | null = null;
      let monthly = ZERO;
      if (isRto) {
        const signedEarlier = i < 2; // signed before the demo history: paid-to-date comes in as an opening credit
        const price = pesos(VEHICLES[i].cost);
        const down = pesos(VEHICLES[i].cost / 10);
        const signed = signedEarlier ? addMonths(start, -8) : start;
        const id = await createRtoContract(
          tx,
          {
            driverId: d.id,
            vehicleId: vehicleIds[i],
            contractPrice: price,
            downPayment: down,
            termMonths: 60,
            startDate: signed,
            firstDueDate: addMonths(signed, 1),
            paidBeforeGoLive: signedEarlier ? down + ((price - down) / BigInt(60)) * BigInt(7) : ZERO,
            notes: DEMO_MARK,
          },
          start,
        );
        contracts++;
        const [acct] = await tx.select({ id: driverAccounts.id }).from(driverAccounts).where(eq(driverAccounts.contractId, id));
        amortAccount = acct.id;
        monthly = (price - down) / BigInt(60);
      }
      const [boundary] = await tx
        .select({ id: driverAccounts.id })
        .from(driverAccounts)
        .where(and(eq(driverAccounts.driverId, d.id), eq(driverAccounts.kind, "boundary")));
      list.push({
        id: d.id,
        rate,
        reliability: i === 7 ? 0.45 : i === 12 ? 0.6 : 0.8 + rand() * 0.15,
        boundaryAccount: boundary.id,
        amortAccount,
        monthly,
        suspendOn: i === 16 ? addDays(start, 30) : null,
      });
    }

    const investorIds: string[] = [];
    for (const [name, phone, plates] of [
      ["Ramon Uy", "09175550101", [0, 7]],
      ["Liza Tan", "09185550202", [8, 9, 10]],
    ] as const) {
      const [row] = await tx.insert(investors).values({ name, phone, notes: `${DEMO_MARK} demo investor` }).returning({ id: investors.id });
      investorIds.push(row.id);
      for (const p of plates) await setVehicleInvestor(tx, vehicleIds[p], row.id);
    }

    const EMP: [string, string, string, "monthly" | "daily", number][] = [
      ["Ana", "Reyes", "Finance officer", "monthly", 28_000],
      ["Benjie", "Cruz", "Collector", "daily", 645],
      ["Carla", "Dizon", "Documentation staff", "monthly", 18_000],
      ["Dino", "Manalo", "Collector", "daily", 645],
      ["Ella", "Soriano", "Sales / CRM", "monthly", 20_000],
    ];
    for (const [i, [firstName, lastName, position, basis, rate]] of EMP.entries()) {
      await tx.insert(employees).values({
        employeeNo: `DEMO-${String(i + 1).padStart(3, "0")}`,
        firstName,
        lastName,
        position,
        hireDate: addDays(start, -300 - i * 60),
        basis,
        rateCentavos: pesos(rate),
      });
    }
    return { people, list, contracts, vehicleCount: vehicleIds.length, investors: investorIds.length, employees: EMP.length };
  });

  // 2. Sixty days of history, one transaction per business day.
  let payments = 0;
  let charges = 0;
  const { people, list } = setup;
  for (let n = 0; n <= daysBetween(start, today); n++) {
    const day = addDays(start, n);
    await runTx(async (tx) => {
      for (const d of list) {
        if (d.suspendOn === day) await tx.update(drivers).set({ status: "suspended" }).where(eq(drivers.id, d.id));
      }
      charges += await postBoundaryCharges(tx, day);
      charges += await postAmortizationCharges(tx, day);
      for (const [k, d] of list.entries()) {
        if (d.suspendOn && day >= d.suspendOn) continue;
        const r = rand();
        let boundary = ZERO;
        if (r < d.reliability) boundary = d.rate;
        else if (r < d.reliability + (1 - d.reliability) / 2) boundary = d.rate / BigInt(2);
        // Good payers settle older arrears on Saturdays.
        if (n % 7 === 6 && d.reliability > 0.7) {
          const [b] = await tx.execute<{ balance: string }>(sql`SELECT balance_centavos::text AS balance FROM public.v_account_balances WHERE account_id = ${d.boundaryAccount}`);
          const owed = BigInt(b.balance);
          if (owed > boundary) boundary = owed;
        }
        let amort = ZERO;
        if (d.amortAccount) {
          const [a] = await tx.execute<{ due: string }>(sql`
            SELECT count(*)::text AS due FROM public.ledger_entries
            WHERE account_id = ${d.amortAccount} AND entry_type = 'amortization_charge' AND due_date = ${day}::date`);
          if (a.due !== "0" && rand() < 0.8) amort = d.monthly;
        }
        const lines = [
          ...(boundary > ZERO ? [{ accountId: d.boundaryAccount, amount: boundary }] : []),
          ...(amort > ZERO ? [{ accountId: d.amortAccount!, amount: amort }] : []),
        ];
        if (lines.length === 0) continue;
        const gcash = rand() < 0.2 || amort > ZERO;
        await recordPayment(tx, {
          clientRequestId: crypto.randomUUID(),
          driverId: d.id,
          method: gcash ? "gcash" : "cash",
          referenceNo: gcash ? String(1_000_000_000 + Math.floor(rand() * 8_999_999_999)) : null,
          receivedAt: new Date(`${day}T18:${String(10 + (k % 40)).padStart(2, "0")}:00+08:00`),
          businessDate: day,
          collectorId: people.collectors[k % people.collectors.length],
          notes: DEMO_MARK,
          lines,
        });
        payments++;
      }
      if (n === 25) {
        await postDriverCharge(tx, { driverId: list[2].id, kind: "cost_charge", amount: pesos(3_450), dueDate: day, memo: "Change oil and brake pads (at cost)" });
      }
      // Collectors hand in each day's cash two days later (the last two days stay unremitted).
      const remitDay = addDays(day, -2);
      if (remitDay >= start && people.receivers.length) {
        for (const collectorId of people.collectors) {
          const cash = await tx.execute<{ id: string }>(sql`
            SELECT id FROM public.v_unremitted_cash WHERE collector_id = ${collectorId} AND business_date = ${remitDay}::date`);
          if (cash.length === 0) continue;
          const [t] = await tx.execute<{ total: string }>(sql`
            SELECT sum(amount_centavos)::text AS total FROM public.payments WHERE id IN (${sql.join(cash.map((c) => sql`${c.id}::uuid`), sql`, `)})`);
          await createRemittance(tx, {
            collectorId,
            paymentIds: cash.map((c) => c.id),
            remitted: BigInt(t.total),
            businessDate: day,
            receivedBy: people.receivers[0],
            notes: DEMO_MARK,
          });
        }
      }
    });
  }

  // 3. The daily job continues from tomorrow.
  await runTx((tx) => tx.insert(chargeRuns).values({ fromDate: start, toDate: today, status: "succeeded", chargesPosted: charges, triggeredBy: "seed:demo", finishedAt: new Date() }));

  // 4. CRM and applications.
  const crm = await runTx(async (tx) => {
    const LEADS: [string, string, "messenger" | "facebook_page" | "walk_in" | "referral" | "landing_page" | "tiktok", "franchise" | "activation" | "vehicle_program" | "investment" | "school", string][] = [
      ["Rodel Pascual", "09195553001", "messenger", "franchise", "Asked about CPC renewal"],
      ["Grace Villareal", "09195553002", "facebook_page", "vehicle_program", "Wants rent-to-own EV"],
      ["Noel Santiago", "09195553003", "walk_in", "activation", "inDrive activation for his own car"],
      ["Lorna Castillo", "09195553004", "referral", "investment", "Referred by Ramon Uy"],
      ["Dennis Aquino", "09195553005", "tiktok", "school", "Driver school schedule?"],
      ["Marites Ocampo", "09195553006", "landing_page", "franchise", "New PA for 2 units"],
      ["Paolo Enriquez", "09195553007", "messenger", "vehicle_program", "Boundary unit available?"],
      ["Jun Villamor", "09195553008", "facebook_page", "activation", "Platform onboarding"],
    ];
    for (const [name, mobile, source, interest, message] of LEADS) {
      await createLead(tx, { name, mobile, source, interest, message, location: "Metro Manila", notes: DEMO_MARK, assignedTo: people.sales });
    }
    const APPS: [string, string, string, string | null][] = [
      ["Marites Ocampo", "09195553006", "ltfrb_pa_new", "requirements_pending"],
      ["Rodel Pascual", "09195553001", "ltfrb_cpc_renewal", "filed"],
      ["Noel Santiago", "09195553003", "platform_activation", "approved"],
      ["Paolo Enriquez", "09195553007", "driver_program", null],
    ];
    for (const [name, mobile, typeKey, status] of APPS) {
      const client = await findOrCreateClient(tx, { name, mobile, notes: DEMO_MARK });
      const app = await createApplication(tx, { typeKey, clientId: client.id, source: "staff", assignedTo: people.sales, notes: DEMO_MARK });
      if (status) await setApplicationStatus(tx, { applicationId: app.id, statusKey: status, note: "Demo data" });
    }
    return { leads: LEADS.length, applications: APPS.length };
  });

  return {
    drivers: 20,
    vehicles: setup.vehicleCount,
    contracts: setup.contracts,
    payments,
    charges,
    leads: crm.leads,
    applications: crm.applications,
    employees: setup.employees,
    investors: setup.investors,
    from: start,
    to: today,
  };
}
