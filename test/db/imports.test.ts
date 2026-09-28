import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate, type IsoDate } from "@/lib/dates";
import type { ImportKind } from "@/lib/imports/kinds";
import { allocateAccount, type EntryType } from "@/lib/ledger/allocation";
import { pesos } from "@/lib/money";
import { postBoundaryCharges } from "@/server/money/charges";
import { readImportFile, sha256Hex } from "@/server/imports/read";
import { runImport, type ImportOutcome } from "@/server/imports/service";
import { as, withSystemTx, withUserTx } from "./app";
import { asUser, createUser, sql } from "./helpers";

/** The sample spreadsheets in docs/import-samples, imported in the documented order. */
const SAMPLES = path.join(__dirname, "../../docs/import-samples");
const TODAY = isoDate("2026-10-01");
const AS_OF = isoDate("2026-09-30");
const MOBILES = ["09175551001", "09175551002", "09175551003", "09175551004", "09175551005", "09175551006"];

let admin: string, finance: string, ops: string;

async function importBytes(kind: ImportKind, fileName: string, bytes: Uint8Array, opts: { commit?: boolean; date?: IsoDate; user?: string } = {}): Promise<ImportOutcome> {
  const table = await readImportFile(fileName, bytes);
  return withUserTx(as(opts.user ?? admin), (tx) =>
    runImport(tx, { kind, fileName, sha256: sha256Hex(bytes), table, commit: opts.commit ?? true, today: TODAY, date: opts.date ?? null }),
  );
}

function sample(file: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(SAMPLES, file)));
}

async function importSample(kind: ImportKind, file: string, date?: IsoDate): Promise<ImportOutcome> {
  const out = await importBytes(kind, file, sample(file), { date });
  expect(out.problem, `${file}: ${out.problem}`).toBeNull();
  expect(out.rows.filter((r) => r.status === "error"), file).toEqual([]);
  expect(out.committed, file).toBe(true);
  return out;
}

async function balances(): Promise<Record<string, Record<string, bigint>>> {
  const rows = await sql<{ phone: string; kind: string; balance: string }[]>`
    SELECT d.phone, b.kind, b.balance_centavos::text AS balance
    FROM public.v_account_balances b JOIN public.drivers d ON d.id = b.driver_id
    WHERE d.phone IN ${sql(MOBILES)}`;
  const out: Record<string, Record<string, bigint>> = {};
  for (const r of rows) (out[r.phone] ??= {})[r.kind] = BigInt(r.balance);
  return out;
}

beforeAll(async () => {
  admin = await createUser("I Admin", ["owner_admin"]);
  finance = await createUser("I Finance", ["finance"]);
  ops = await createUser("I Ops", ["operations"]);
});

afterAll(async () => {
  // Other test files share this database and assume they own every active employee and
  // investor vehicle: retire what the samples created (employees and vehicles can't be deleted).
  await sql`UPDATE public.employees SET status = 'inactive', separation_date = '2026-09-30' WHERE employee_no LIKE 'TR-%'`;
  await sql`UPDATE public.vehicles SET investor_id = NULL, funding_source = 'company' WHERE plate_no ILIKE 'NGA%'`;
  await sql.end();
});

describe("migration of the sample spreadsheets, end to end", () => {
  it("previews without writing anything", async () => {
    const out = await importBytes("vehicles", "01-vehicles.csv", sample("01-vehicles.csv"), { commit: false });
    expect(out.committed).toBe(false);
    expect(out.counts).toMatchObject({ rows: 8, errors: 0, ready: 8 });
    const [n] = await sql`SELECT count(*)::int AS n FROM public.vehicles WHERE plate_no LIKE 'NGA %'`;
    expect(n.n).toBe(0);
  });

  it("imports every file in order", async () => {
    await importSample("vehicles", "01-vehicles.csv");
    const drivers = await importSample("drivers", "02-drivers.xlsx");
    expect(drivers.counts.ready).toBe(6);
    await importSample("boundary_plans", "03-boundary-plans.csv", TODAY);
    const contracts = await importSample("rto_contracts", "04-rto-contracts.csv");
    expect(contracts.totals.find((t) => t.label === "Amortization balance after import")?.value).toBe("₱43,000.00");
    const ob = await importSample("opening_balances", "05-opening-balances.csv", AS_OF);
    expect(ob.totals.find((t) => t.label === "Net opening balance")?.value).toBe("₱24,500.00");

    const ledgerBefore = await sql`SELECT count(*)::int AS n, coalesce(sum(amount_centavos), 0)::text AS s FROM public.ledger_entries`;
    await importSample("legacy_payments", "06-legacy-payments.csv", AS_OF);
    const ledgerAfter = await sql`SELECT count(*)::int AS n, coalesce(sum(amount_centavos), 0)::text AS s FROM public.ledger_entries`;
    expect(ledgerAfter).toEqual(ledgerBefore); // reference only: the ledger is untouched

    await importSample("employees", "07-employees.csv");
    await importSample("investors", "08-investors.csv");
    const leads = await importSample("leads", "09-leads.csv");
    expect(leads.counts.ready).toBe(5);
  });

  it("created the drivers from Excel cells correctly", async () => {
    const rows = await sql`
      SELECT first_name, last_name, phone, birthdate::text, status, preferred_language FROM public.drivers
      WHERE phone IN ${sql(MOBILES)} ORDER BY phone`;
    expect(rows.map((r) => `${r.first_name} ${r.last_name}`)).toEqual([
      "Ramil Bautista", "Jerome Villanueva", "Arnel Garcia", "Christian Mendoza", "Mark Anthony Reyes", "Joel Ramos",
    ]);
    expect(rows[2]).toMatchObject({ phone: "09175551003", birthdate: "1990-05-12", status: "active" }); // number cell + text date
    expect(rows[0].birthdate).toBe("1986-02-14"); // date cell
    expect(rows[4].preferred_language).toBe("taglish");
    expect(rows[5].status).toBe("suspended");
  });

  it("started plans from go-live and assigned the vehicles", async () => {
    const rows = await sql`
      SELECT d.phone, p.daily_rate_centavos::text AS rate, p.program_type, p.effective_from::text AS start, v.plate_no, v.status
      FROM public.boundary_plans p JOIN public.drivers d ON d.id = p.driver_id
      JOIN public.vehicle_assignments a ON a.driver_id = d.id AND a.end_date IS NULL
      JOIN public.vehicles v ON v.id = a.vehicle_id
      WHERE d.phone IN ${sql(MOBILES)} ORDER BY d.phone`;
    expect(rows.map((r) => [r.phone, r.rate, r.program_type, r.start, r.plate_no, r.status])).toEqual([
      ["09175551001", "100000", "boundary", "2026-10-01", "NGA 1001", "assigned"],
      ["09175551002", "85000", "boundary", "2026-10-01", "NGA 1003", "assigned"],
      ["09175551003", "85000", "boundary", "2026-10-01", "NGA 1004", "assigned"],
      ["09175551004", "70000", "rto", "2026-10-01", "NGA 1002", "assigned"],
      ["09175551005", "75000", "rto", "2026-10-01", "NGA 1008", "assigned"],
    ]);
  });

  it("created the RTO contracts with installments due so far and the paid-to-date credit", async () => {
    const rows = await sql`
      SELECT d.phone, c.contract_price_centavos::text AS price, c.term_months, c.first_due_date::text AS first_due, c.notes
      FROM public.rto_contracts c JOIN public.drivers d ON d.id = c.driver_id
      WHERE d.phone IN ${sql(MOBILES)} ORDER BY d.phone`;
    expect(rows.map((r) => [r.phone, r.price, r.term_months, r.first_due])).toEqual([
      ["09175551004", "120000000", 60, "2025-11-01"],
      ["09175551005", "150000000", 60, "2026-04-15"],
    ]);
    expect(rows[0].notes).toMatch(/old contract no\. HULOG-2025-07/);
  });

  it("ends with the expected balances, each equal to the sum of its ledger", async () => {
    const b = await balances();
    expect(b["09175551001"]).toEqual({ boundary: pesos(2000), charges: BigInt(0) });
    expect(b["09175551002"]).toEqual({ boundary: -pesos(850), charges: BigInt(0) });
    expect(b["09175551003"]).toEqual({ boundary: pesos(850), charges: pesos(3500) });
    // DP ₱120,000 + 12 installments of ₱18,000 due by Oct 1 − ₱318,000 paid = one installment.
    expect(b["09175551004"]).toEqual({ boundary: pesos(1400), charges: BigInt(0), amortization: pesos(18_000) });
    // 6 installments of ₱25,000 (Apr–Sep) − ₱125,000 paid.
    expect(b["09175551005"]).toEqual({ boundary: BigInt(0), charges: BigInt(0), amortization: pesos(25_000) });
    expect(b["09175551006"]).toEqual({ boundary: pesos(12_600), charges: pesos(5000) });

    const accounts = await sql<{ id: string; balance: string }[]>`
      SELECT b.account_id AS id, b.balance_centavos::text AS balance FROM public.v_account_balances b
      JOIN public.drivers d ON d.id = b.driver_id WHERE d.phone IN ${sql(MOBILES)}`;
    for (const a of accounts) {
      const entries = await sql`SELECT * FROM public.ledger_entries WHERE account_id = ${a.id}`;
      const ledgerSum = entries.reduce((s, e) => s + BigInt(e.amount_centavos), BigInt(0));
      expect(ledgerSum).toBe(BigInt(a.balance));
      const alloc = allocateAccount(
        entries.map((e) => ({
          id: e.id, seq: BigInt(e.seq), entryType: e.entry_type as EntryType, amount: BigInt(e.amount_centavos),
          businessDate: e.business_date, dueDate: e.due_date, reversesEntryId: e.reverses_entry_id,
        })),
      );
      expect(alloc.balance).toBe(BigInt(a.balance));
    }
  });

  it("tags opening balances with type and import key, and never posts them twice", async () => {
    const [tagged] = await sql`
      SELECT count(*)::int AS n FROM public.ledger_entries e JOIN public.drivers d ON d.id = e.driver_id
      WHERE d.phone IN ${sql(MOBILES)} AND e.entry_type = 'opening_balance' AND e.idempotency_key LIKE 'import:%'`;
    expect(tagged.n).toBe(9); // 7 opening balance rows + 2 RTO paid-to-date credits

    const again = await importBytes("opening_balances", "05-opening-balances.csv", sample("05-opening-balances.csv"), { date: AS_OF });
    expect(again.committed).toBe(false);
    expect(again.problem).toMatch(/already imported/);

    // Same rows in a slightly different file: every account already has its opening balance.
    const edited = new TextEncoder().encode(`${new TextDecoder().decode(sample("05-opening-balances.csv"))}\n`);
    const out = await importBytes("opening_balances", "opening-v2.csv", edited, { date: AS_OF });
    expect(out.committed).toBe(false);
    expect(out.rows.every((r) => r.status === "error" && /already has an opening balance/.test(r.note))).toBe(true);
  });

  it("re-importing existing records skips them", async () => {
    const edited = new TextEncoder().encode(`${new TextDecoder().decode(sample("01-vehicles.csv"))}\n`);
    const out = await importBytes("vehicles", "vehicles-again.csv", edited);
    expect(out.committed).toBe(true);
    expect(out.counts).toMatchObject({ ready: 0, skipped: 8 });
    const [n] = await sql`SELECT count(*)::int AS n FROM public.vehicles WHERE plate_no ILIKE 'NGA%'`;
    expect(n.n).toBe(8);
  });

  it("linked investors, stored payments before go-live, employees and leads", async () => {
    const inv = await sql`
      SELECT i.name, array_agg(v.plate_no ORDER BY v.plate_no) AS plates, bool_and(v.funding_source = 'investor') AS funded
      FROM public.investors i JOIN public.vehicles v ON v.investor_id = i.id
      WHERE i.name IN ('Ramon Uy', 'Liza Tan') GROUP BY i.name ORDER BY i.name`;
    expect(inv.map((r) => [r.name, r.plates, r.funded])).toEqual([
      ["Liza Tan", ["NGA 1006", "NGA-1005"], true], // plates are kept as typed (uppercased); matching ignores spaces and dashes
      ["Ramon Uy", ["NGA 1001"], true],
    ]);
    const [lp] = await sql`SELECT count(*)::int AS n, sum(amount_centavos)::text AS s FROM public.legacy_payments`;
    expect(lp).toEqual({ n: 6, s: String(pesos(47_200)) });
    const emp = await sql`SELECT employee_no, basis, rate_centavos::text AS rate FROM public.employees WHERE employee_no LIKE 'TR-%' ORDER BY 1`;
    expect(emp.map((e) => [e.employee_no, e.basis, e.rate])).toEqual([
      ["TR-001", "monthly", "2800000"],
      ["TR-002", "daily", "64500"],
      ["TR-003", "monthly", "1800000"],
    ]);
    const [leads] = await sql`SELECT count(*)::int AS n FROM public.leads WHERE mobile IN ('09195553001', '09195553002', '09195553003', '09195553005') OR email = 'lorna@example.com'`;
    expect(leads.n).toBe(5);
    const batches = await sql`SELECT kind, row_count FROM public.import_batches ORDER BY created_at`;
    expect(batches.map((b) => b.kind)).toEqual([
      "vehicles", "drivers", "boundary_plans", "rto_contracts", "opening_balances", "legacy_payments", "employees", "investors", "leads", "vehicles",
    ]);
  });

  it("the first daily charge applies against the opening balances", async () => {
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, TODAY));
    const b = await balances();
    expect(b["09175551001"].boundary).toBe(pesos(3000));
    expect(b["09175551002"].boundary).toBe(BigInt(0)); // the advance covered Oct 1
    expect(b["09175551006"].boundary).toBe(pesos(12_600)); // suspended, no plan: not charged
  });
});

describe("guards", () => {
  it("reports missing columns and refuses plans that start in the past", async () => {
    const out = await importBytes("opening_balances", "x.csv", new TextEncoder().encode("mobile,amount\n09170000001,5\n"), { date: AS_OF });
    expect(out.problem).toMatch(/Missing column: account/);
    const past = await importBytes("boundary_plans", "p.csv", sample("03-boundary-plans.csv"), { date: isoDate("2026-09-01"), commit: false });
    expect(past.problem).toMatch(/can't start in the past/);
    const future = await importBytes("legacy_payments", "l.csv", sample("06-legacy-payments.csv"), { date: isoDate("2026-10-05"), commit: false });
    expect(future.problem).toMatch(/can't be in the future/);
  });

  it("unknown drivers block the whole file", async () => {
    const csv = "mobile,account,amount\n09175551001,boundary,100\n09990000000,boundary,100\n";
    const out = await importBytes("opening_balances", "unknown.csv", new TextEncoder().encode(csv), { date: AS_OF });
    expect(out.committed).toBe(false);
    expect(out.rows[1].note).toMatch(/No driver with mobile 09990000000/);
  });

  it("import tables are owner_admin only; legacy payments are visible to finance and operations", async () => {
    for (const u of [finance, ops]) {
      const r = await asUser(u, (tx) => tx`SELECT count(*)::int AS n FROM public.import_batches`);
      expect(r[0].n).toBe(0);
      const p = await asUser(u, (tx) => tx`SELECT count(*)::int AS n FROM public.legacy_payments`);
      expect(p[0].n).toBe(6);
    }
    const [batch] = await sql`SELECT id FROM public.import_batches WHERE kind = 'legacy_payments'`;
    const [driver] = await sql`SELECT id FROM public.drivers WHERE phone = '09175551001'`;
    await expect(
      asUser(finance, (tx) => tx`INSERT INTO public.legacy_payments (driver_id, paid_on, amount_centavos, batch_id, line, created_by)
        VALUES (${driver.id}, '2026-01-01', 100, ${batch.id}, 999, ${finance})`),
    ).rejects.toThrow(/row-level security/);
    await expect(sql`UPDATE public.legacy_payments SET amount_centavos = 1`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM public.import_batches`).rejects.toThrow(/append-only/);
  });

  it("a non-admin cannot commit an import", async () => {
    const csv = new TextEncoder().encode("plate_no,make,model\nNGZ 9999,Toyota,Vios\n");
    await expect(importBytes("vehicles", "v.csv", csv, { user: ops })).rejects.toThrow();
    const [n] = await sql`SELECT count(*)::int AS n FROM public.vehicles WHERE plate_no = 'NGZ 9999'`;
    expect(n.n).toBe(0);
  });
});
