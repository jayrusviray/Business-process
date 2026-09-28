import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate, type IsoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import { createVehicleLoan, recordLoanPayment, reverseLoanPayment } from "@/server/money/loans";
import { ensureAccount } from "@/server/money/fleet";
import { recordPayment, reverseEntry, voidPayment } from "@/server/money/payments";
import { reassignCashRecord, recordCashTransaction, recordTransfer, reconcileAccount, voidCashTransaction } from "@/server/office/cashbook";
import { recordExpense, voidExpense } from "@/server/office/expenses";
import { giveCashAdvance, liquidateCashAdvance, returnCashAdvance } from "@/server/office/payroll";
import { as, schema, withUserTx } from "./app";
import { asUser, createUser, expectDbError, sql } from "./helpers";

const { drivers, vehicles, employees } = schema;
const D = isoDate;
const TODAY = D("2026-09-28");
let admin: string, finance: string, ops: string, sales: string;
let driverId: string, boundaryAcc: string, chargesAcc: string, vehicleId: string, employeeId: string;
const acct: Record<string, string> = {};

/** Every cash book row created by this file is identified by its source id. */
const mine = new Set<string>();

async function rows(ids: Iterable<string> = mine) {
  return withUserTx(as(finance), (tx) =>
    tx.execute<{ source_type: string; source_id: string; line_key: string; direction: string; amount_centavos: string; category: string; account_id: string; entry_date: string }>(dsql`
      SELECT source_type, source_id, line_key, direction, amount_centavos::text, category, account_id, entry_date::text
      FROM public.v_cash_book WHERE source_id IN (${dsql.join([...ids].map((i) => dsql`${i}::uuid`), dsql`, `)}) ORDER BY entry_date, created_at, line_key`),
  );
}

async function charge(accountId: string, due: IsoDate, amount = 700) {
  const [e] = await sql`
    INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date, vehicle_id, memo)
    VALUES (${accountId}, ${driverId}, 'boundary_charge', ${String(pesos(amount))}, ${due}, ${due}, ${vehicleId}, 'test boundary')
    RETURNING id`;
  return e.id as string;
}

async function pay(amount: number, date: IsoDate, method: "cash" | "gcash" = "cash", accountId = boundaryAcc) {
  const p = await withUserTx(as(finance), (tx) =>
    recordPayment(tx, {
      clientRequestId: crypto.randomUUID(),
      driverId,
      method,
      referenceNo: method === "cash" ? null : "REF-1",
      receivedAt: new Date(`${date}T02:00:00Z`),
      businessDate: date,
      collectorId: finance,
      lines: [{ accountId, amount: pesos(amount) }],
    }),
  );
  mine.add(p.id);
  return p.id;
}

beforeAll(async () => {
  admin = await createUser("CB Admin", ["owner_admin"]);
  finance = await createUser("CB Finance", ["finance"]);
  ops = await createUser("CB Ops", ["operations"]);
  sales = await createUser("CB Sales", ["sales"]);
  for (const r of await sql`SELECT id, payment_method FROM public.cash_accounts`) acct[r.payment_method] = r.id;
  ({ driverId, vehicleId } = await withUserTx(as(ops), async (tx) => {
    const [d] = await tx.insert(drivers).values({ firstName: "Cash", lastName: "Book", phone: "09175550001", status: "active" }).returning({ id: drivers.id });
    const [v] = await tx.insert(vehicles).values({ plateNo: `CB ${Math.floor(Math.random() * 1e6)}`, make: "Toyota", model: "Vios" }).returning({ id: vehicles.id });
    return { driverId: d.id, vehicleId: v.id };
  }));
  boundaryAcc = await withUserTx(as(ops), (tx) => ensureAccount(tx, driverId, "boundary", D("2025-01-01")));
  chargesAcc = await withUserTx(as(ops), (tx) => ensureAccount(tx, driverId, "charges", D("2025-01-01")));
  employeeId = await withUserTx(as(finance), async (tx) => {
    const [e] = await tx
      .insert(employees)
      .values({ employeeNo: "CB-1", firstName: "Cara", lastName: "Advance", hireDate: "2025-01-01", basis: "monthly", rateCentavos: pesos(20_000), status: "inactive" })
      .returning({ id: employees.id });
    return e.id;
  });
});

afterAll(async () => {
  await sql.end();
});

describe("cash book read model", () => {
  it("routes each record to the account of its payment method; voided rows never count", async () => {
    const cash = await pay(700, D("2025-02-03"));
    const gcash = await pay(1_400, D("2025-02-03"), "gcash");
    const voided = await pay(700, D("2025-02-04"));
    await withUserTx(as(finance), (tx) => voidPayment(tx, { paymentId: voided, reason: "wrong driver", voidedBy: finance }));
    const cat = (await sql`SELECT id FROM public.expense_categories WHERE name = 'Utilities'`)[0].id;
    const [exp, badExp] = await withUserTx(as(finance), async (tx) => [
      await recordExpense(tx, { categoryId: cat, description: "Meralco", amount: pesos(2_000), expenseDate: D("2025-02-05"), paidVia: "gcash" }),
      await recordExpense(tx, { categoryId: cat, description: "Duplicate", amount: pesos(2_000), expenseDate: D("2025-02-05"), paidVia: "cash" }),
    ]);
    await withUserTx(as(finance), (tx) => voidExpense(tx, badExp, "entered twice", finance));
    for (const id of [exp, badExp]) mine.add(id);

    const r = await rows([cash, gcash, voided, exp, badExp]);
    expect(r.map((x) => [x.source_id, x.direction, x.amount_centavos, x.category, x.account_id])).toEqual([
      [cash, "in", "70000", "boundary", acct.cash],
      [gcash, "in", "140000", "boundary", acct.gcash],
      [exp, "out", "200000", "expense", acct.gcash],
    ]);
  });

  it("splits a payment by account line (boundary vs driver costs)", async () => {
    const p = await withUserTx(as(finance), (tx) =>
      recordPayment(tx, {
        clientRequestId: crypto.randomUUID(),
        driverId,
        method: "cash",
        receivedAt: new Date("2025-02-10T02:00:00Z"),
        businessDate: D("2025-02-10"),
        collectorId: finance,
        lines: [
          { accountId: boundaryAcc, amount: pesos(700) },
          { accountId: chargesAcc, amount: pesos(300) },
        ],
      }),
    );
    mine.add(p.id);
    const r = await rows([p.id]);
    expect(r.map((x) => [x.line_key, x.category, x.amount_centavos])).toEqual([
      ["boundary", "boundary", "70000"],
      ["charges", "driver_charges", "30000"],
    ]);
  });

  it("counts a cash advance once: given (out), liquidated (no cash), returned (in)", async () => {
    const ca = await withUserTx(as(finance), (tx) => giveCashAdvance(tx, { employeeId, givenOn: D("2025-03-01"), amount: pesos(3_000), purpose: "Client meeting" }));
    await withUserTx(as(finance), (tx) => liquidateCashAdvance(tx, { cashAdvanceId: ca, amount: pesos(1_800), settledOn: D("2025-03-03"), description: "Meals" }));
    await withUserTx(as(finance), (tx) => returnCashAdvance(tx, { cashAdvanceId: ca, amount: pesos(1_200), settledOn: D("2025-03-04") }));
    const ids = [ca, ...(await sql`SELECT id FROM public.cash_advance_settlements WHERE cash_advance_id = ${ca}`).map((s) => s.id as string)];
    const liquidationExpense = (await sql`SELECT expense_id FROM public.cash_advance_settlements WHERE cash_advance_id = ${ca} AND kind = 'liquidation'`)[0].expense_id;
    ids.push(liquidationExpense);
    ids.forEach((i) => mine.add(i));
    const r = await rows(ids);
    expect(r.map((x) => [x.source_type, x.direction, x.amount_centavos, x.account_id])).toEqual([
      ["cash_advance", "out", "300000", acct.cash],
      ["cash_advance_settlement", "in", "120000", acct.cash],
    ]);
  });

  it("drops a corrected loan payment and its correction; records without a method go to the routed account", async () => {
    const loan = await withUserTx(as(finance), (tx) =>
      createVehicleLoan(tx, { vehicleId, lender: "BDO", principal: pesos(100_000), annualRateBps: 1200, termMonths: 12, firstDueDate: D("2025-04-15") }),
    );
    const good = await withUserTx(as(finance), (tx) => recordLoanPayment(tx, { loanId: loan, paidOn: D("2025-04-15"), amount: pesos(8_885) }));
    const bad = await withUserTx(as(finance), (tx) => recordLoanPayment(tx, { loanId: loan, paidOn: D("2025-04-16"), amount: pesos(8_885) }));
    await withUserTx(as(finance), (tx) => reverseLoanPayment(tx, { paymentId: bad, reason: "double entry", today: D("2025-04-17") }));
    const correction = (await sql`SELECT id FROM public.loan_payments WHERE reverses_payment_id = ${bad}`)[0].id as string;
    [good, bad, correction].forEach((i) => mine.add(i));
    const r = await rows([good, bad, correction]);
    // Default routing for loan payments is "other" until the owner chooses (setting cashbook.default_routing).
    expect(r.map((x) => [x.source_id, x.category, x.account_id])).toEqual([[good, "loan_amortization", acct.other]]);

    // Finance moves it to the bank; the record itself is untouched.
    await withUserTx(as(finance), (tx) => reassignCashRecord(tx, { sourceType: "loan_payment", sourceId: good, accountId: acct.bank_transfer, reason: "Paid from BDO" }));
    expect((await rows([good]))[0].account_id).toBe(acct.bank_transfer);
    await expect(withUserTx(as(finance), (tx) => reassignCashRecord(tx, { sourceType: "loan_payment", sourceId: bad, accountId: acct.cash, reason: "x" }))).rejects.toThrow(/not in the cash book/);
  });

  it("a transfer is two legs that net to zero; voiding removes both", async () => {
    const t = await withUserTx(as(finance), (tx) =>
      recordTransfer(tx, { entryDate: D("2025-05-02"), fromAccountId: acct.cash, toAccountId: acct.bank_transfer, amount: pesos(10_000), description: "Deposit to BDO" }, TODAY),
    );
    mine.add(t);
    const r = await rows([t]);
    expect(r.map((x) => [x.line_key, x.category, x.direction, x.account_id])).toEqual([
      ["in", "transfer_in", "in", acct.bank_transfer],
      ["out", "transfer_out", "out", acct.cash],
    ]);
    await withUserTx(as(finance), (tx) => voidCashTransaction(tx, t, "wrong amount", finance));
    expect(await rows([t])).toEqual([]);
    await expectDbError(sql`UPDATE public.cash_transactions SET amount_centavos = 1 WHERE id = ${t}`, /already void/);
    await expectDbError(sql`DELETE FROM public.cash_transactions WHERE id = ${t}`, /append-only/);
  });

  it("the lean movements view gives the same balance per account as the detailed book", async () => {
    const [a, b] = await withUserTx(as(finance), async (tx) => [
      await tx.execute(dsql`SELECT account_id, SUM(signed_centavos)::text AS s FROM public.v_cash_book GROUP BY account_id ORDER BY account_id`),
      await tx.execute(dsql`SELECT account_id, SUM(signed_centavos)::text AS s FROM public.v_cash_movements GROUP BY account_id ORDER BY account_id`),
    ]);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(1);
  });
});

describe("reconciliation", () => {
  it("stores the book balance computed by the database and is immutable", async () => {
    const other = await withUserTx(as(finance), (tx) =>
      recordCashTransaction(tx, { entryDate: D("2025-06-01"), category: "opening_balance", accountId: acct.maya, amount: pesos(5_000), description: "Maya opening balance" }, TODAY),
    );
    mine.add(other);
    const expected = (await withUserTx(as(finance), (tx) => tx.execute<{ b: string }>(dsql`SELECT app.cash_balance(${acct.maya}::uuid, '2025-06-30'::date)::text AS b`)))[0].b;
    const res = await withUserTx(as(finance), (tx) => reconcileAccount(tx, { accountId: acct.maya, asOfDate: D("2025-06-30"), counted: pesos(4_900) }, TODAY));
    expect(res.system.toString()).toBe(expected);
    expect(res.variance).toBe(pesos(4_900) - BigInt(expected));
    // A client can't smuggle in its own "system" figure.
    const [forged] = await asUser(finance, (tx) => tx`
      INSERT INTO public.cash_reconciliations (account_id, as_of_date, counted_centavos, system_centavos) VALUES (${acct.maya}, '2025-06-30', 1, 999999999)
      RETURNING system_centavos::text AS s`);
    expect(forged.s).toBe(expected);
    await expectDbError(sql`UPDATE public.cash_reconciliations SET counted_centavos = 1 WHERE id = ${res.id}`, /append-only/);
    await expectDbError(sql`DELETE FROM public.cash_reconciliations WHERE id = ${res.id}`, /append-only/);
    await expectDbError(withUserTx(as(finance), (tx) => reconcileAccount(tx, { accountId: acct.maya, asOfDate: D("2099-01-01"), counted: pesos(1) }, D("2099-01-01"))), /hasn't happened/);
  });
});

describe("RLS", () => {
  it("only owner/admin and finance see the cash book and its tables", async () => {
    for (const u of [admin, finance]) {
      const [n] = await asUser(u, (tx) => tx`SELECT count(*)::int AS n FROM public.v_cash_book`);
      expect(n.n).toBeGreaterThan(0);
    }
    for (const u of [ops, sales]) {
      for (const t of ["v_cash_book", "v_cash_movements", "cash_accounts", "cash_transactions", "cash_reconciliations"]) {
        const [n] = await asUser(u, (tx) => tx.unsafe(`SELECT count(*)::int AS n FROM public.${t}`));
        expect(n.n, `${t} as ${u === ops ? "operations" : "sales"}`).toBe(0);
      }
    }
    await expect(
      asUser(ops, (tx) => tx`INSERT INTO public.cash_transactions (entry_date, category, account_id, amount_centavos, description, created_by)
        VALUES ('2025-01-01', 'other_in', ${acct.cash}, 100, 'x', ${ops})`),
    ).rejects.toThrow(/row-level security|does not exist/);
    await expect(asUser(null, (tx) => tx`SELECT 1 FROM public.v_cash_book LIMIT 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("open charges (fast path for dashboards)", () => {
  it("matches v_charge_status, including partial payments, voids and reversed charges", async () => {
    const days = ["2025-07-01", "2025-07-02", "2025-07-03", "2025-07-04", "2025-07-05"].map(D);
    const ids: string[] = [];
    for (const d of days) ids.push(await charge(boundaryAcc, d, 2_000));
    await withUserTx(as(finance), (tx) => reverseEntry(tx, { entryId: ids[3], reason: "holiday", businessDate: D("2025-07-06") }));
    await pay(1_000, D("2025-07-06"));
    const v = await pay(700, D("2025-07-06"));
    await withUserTx(as(finance), (tx) => voidPayment(tx, { paymentId: v, reason: "bounced", voidedBy: finance }));

    const [fast, view] = await withUserTx(as(finance), async (tx) => [
      await tx.execute<{ entry_id: string; o: string }>(dsql`SELECT entry_id, outstanding_centavos::text AS o FROM app.open_charges(NULL) WHERE account_id = ${boundaryAcc}::uuid ORDER BY entry_id`),
      await tx.execute<{ entry_id: string; o: string }>(dsql`SELECT entry_id, outstanding_centavos::text AS o FROM public.v_charge_status WHERE account_id = ${boundaryAcc}::uuid AND outstanding_centavos > 0 ORDER BY entry_id`),
    ]);
    expect(fast).toEqual(view);
    expect(fast.length).toBeGreaterThan(0);

    // Point in time: before the 2025-07-06 payment everything posted by 07-05 was open.
    const [asOf] = await withUserTx(as(finance), (tx) =>
      tx.execute<{ o: string }>(dsql`SELECT COALESCE(SUM(outstanding_centavos), 0)::text AS o FROM app.open_charges('2025-07-05') WHERE account_id = ${boundaryAcc}::uuid`),
    );
    const [bal] = await sql`SELECT SUM(amount_centavos)::text AS b FROM public.ledger_entries WHERE account_id = ${boundaryAcc} AND business_date <= '2025-07-05'`;
    expect(asOf.o).toBe(BigInt(bal.b) > BigInt(0) ? bal.b : "0");
  });

  it("drivers only see their own open charges", async () => {
    const [n] = await asUser(sales, (tx) => tx`SELECT count(*)::int AS n FROM app.open_charges(NULL)`);
    expect(n.n).toBe(0);
  });
});
