import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeHeader, parseCsv } from "../csv";
import { isoDate } from "../dates";
import { pesos } from "../money";
import { IMPORT_KIND_INFO, IMPORT_KINDS, matchHeaders, templateName, type ImportKind } from "./kinds";
import {
  validateContractRows,
  validateDriverRows,
  validateEmployeeRows,
  validateInvestorRows,
  validateLegacyPaymentRows,
  validateOpeningBalanceRows,
  validatePlanRows,
  validateVehicleRows,
  type RawRow,
  type RowContext,
} from "./rows";

const ctx: RowContext = {
  today: isoDate("2026-10-01"),
  asOf: isoDate("2026-09-30"),
  startDate: isoDate("2026-10-01"),
  date1904: false,
  defaultTermMonths: 60,
};

/** Rows keyed by normalised header, the way the file reader produces them. */
function table(kind: ImportKind, csv: string): { rows: RawRow[]; cols: Map<string, string> } {
  const [head, ...body] = parseCsv(csv);
  const headers = head.map(normalizeHeader);
  const rows = body.map((cells, i) => ({ line: i + 2, values: Object.fromEntries(headers.map((h, j) => [h, (cells[j] ?? "").trim()])) }));
  return { rows, cols: matchHeaders(kind, headers).columns };
}

describe("header matching", () => {
  it("accepts aliases and reports missing and ignored columns", () => {
    const m = matchHeaders("vehicles", ["plate_number", "brand", "model", "fuel_type", "favorite_food"]);
    expect(m.columns.get("plate_no")).toBe("plate_number");
    expect(m.columns.get("make")).toBe("brand");
    expect(m.columns.get("powertrain")).toBe("fuel_type");
    expect(m.missing).toEqual([]);
    expect(m.ignored).toEqual(["favorite_food"]);
    expect(matchHeaders("opening_balances", ["mobile", "amount"]).missing).toEqual(["account"]);
  });
  it("prefers an exact column over another column's alias", () => {
    // "type" is an alias of both program and account; "program" itself is present.
    const m = matchHeaders("boundary_plans", ["mobile", "program", "type", "daily_rate"]);
    expect(m.columns.get("program")).toBe("program");
    expect(m.ignored).toEqual(["type"]);
  });
  it("every template in public/templates has exactly the documented columns", () => {
    for (const kind of IMPORT_KINDS) {
      const file = path.join(process.cwd(), "public/templates", `${templateName(kind)}.csv`);
      const [head] = parseCsv(readFileSync(file, "utf8"));
      expect(head.map(normalizeHeader), kind).toEqual(IMPORT_KIND_INFO[kind].columns.map((c) => c.key));
    }
  });
});

describe("vehicles", () => {
  it("parses a full row and defaults the rest", () => {
    const { rows, cols } = table(
      "vehicles",
      "Plate No.,Make,Model,Year,Type,OR/CR Expiry,Acquisition Cost,Funding\nnbc  1234,BYD,e6,2023,Electric,12/31/2026,\"1,650,000\",investor\nNBC 5678,Toyota,Vios,,,,,\n",
    );
    const [a, b] = validateVehicleRows(rows, cols, ctx);
    expect(a.error).toBeUndefined();
    expect(a.data).toMatchObject({ plateNo: "NBC 1234", powertrain: "ev", year: 2023, orcrExpiresOn: "2026-12-31", acquisitionCost: pesos(1_650_000), fundingSource: "investor" });
    expect(b.data).toMatchObject({ powertrain: "ice", year: null, fundingSource: "company", status: "available", acquisitionCost: null });
  });
  it("flags bad cells and duplicate plates", () => {
    const { rows, cols } = table(
      "vehicles",
      "plate_no,make,model,year,powertrain\nABC 1,Toyota,Vios,1985,ice\nABC 2,Toyota,Vios,2020,rocket\nABC 3,,Vios,,\nABC 4,Toyota,Vios,,\nabc-4,Toyota,Wigo,,\n",
    );
    const out = validateVehicleRows(rows, cols, ctx);
    expect(out[0].error).toMatch(/year: must be between 1990 and 2100/);
    expect(out[1].error).toMatch(/powertrain: "rocket" is not a valid type/);
    expect(out[2].error).toBe("make is required");
    expect(out[3].error).toBeUndefined();
    expect(out[4].error).toBe("Same plate as line 5.");
  });
});

describe("drivers", () => {
  it("splits a full name, normalises the mobile and defaults to active", () => {
    const { rows, cols } = table("drivers", "Name,Mobile Number,Birthday\nJuan Dela Cruz,+63 917 123 4567,5/3/1985\n");
    const [d] = validateDriverRows(rows, cols, ctx);
    expect(d.data).toMatchObject({ firstName: "Juan", lastName: "Dela Cruz", phone: "09171234567", birthdate: "1985-05-03", status: "active", preferredLanguage: "taglish" });
  });
  it("reads a mobile number that Excel stored as a number (leading zero lost)", () => {
    const { rows, cols } = table("drivers", "first_name,last_name,mobile\nMaria,Santos,9181234567\n");
    expect(validateDriverRows(rows, cols, ctx)[0].data?.phone).toBe("09181234567");
  });
  it("rejects bad mobiles, missing names and duplicates", () => {
    const { rows, cols } = table("drivers", "first_name,last_name,mobile\nA,B,12345\n,Solo,09170000001\nC,D,09170000002\nE,F,0917-000-0002\n");
    const out = validateDriverRows(rows, cols, ctx);
    expect(out[0].error).toMatch(/not a PH mobile number/);
    expect(out[1].error).toMatch(/first and last name/);
    expect(out[2].error).toBeUndefined();
    expect(out[3].error).toBe("Same mobile number as line 4.");
  });
});

describe("boundary plans", () => {
  it("defaults the start date and refuses plans that start in the past", () => {
    const { rows, cols } = table("boundary_plans", "mobile,plate_no,program,daily_rate,start_date\n09170000001,NBC 1234,Boundary-Hulog,700,\n09170000002,,boundary,650,2026-09-15\n09170000003,,,0,\n");
    const out = validatePlanRows(rows, cols, ctx);
    expect(out[0].data).toMatchObject({ programType: "rto", dailyRate: pesos(700), startDate: "2026-10-01", plateKey: "NBC1234" });
    expect(out[1].error).toMatch(/in the past/);
    expect(out[2].error).toMatch(/more than ₱0.00/);
  });
  it("one plan per driver and per vehicle", () => {
    const { rows, cols } = table("boundary_plans", "mobile,plate_no,daily_rate\n09170000001,NBC 1,700\n09170000001,NBC 2,700\n09170000003,nbc-1,700\n");
    const out = validatePlanRows(rows, cols, ctx);
    expect(out.map((r) => r.error ?? null)).toEqual([null, "Same driver as line 2 (one plan per driver).", "Same vehicle as line 2."]);
  });
});

describe("RTO contracts", () => {
  it("uses the default term and checks the terms", () => {
    const { rows, cols } = table(
      "rto_contracts",
      "mobile,plate_no,contract_price,down_payment,start_date,first_due_date,paid_to_date\n" +
        "09170000001,NBC 1,\"900,000\",\"60,000\",2025-10-01,2025-11-01,\"210,000\"\n" +
        "09170000002,NBC 2,500000,500000,2025-10-01,2025-11-01,0\n" +
        "09170000003,NBC 3,500000,0,2025-10-01,2025-09-01,0\n" +
        "09170000004,NBC 4,500000,0,2025-10-01,2025-11-01,600000\n",
    );
    const out = validateContractRows(rows, cols, ctx);
    expect(out[0].data).toMatchObject({ contractPrice: pesos(900_000), downPayment: pesos(60_000), termMonths: 60, paidToDate: pesos(210_000) });
    expect(out[1].error).toMatch(/Down payment/);
    expect(out[2].error).toMatch(/first due date/);
    expect(out[3].error).toMatch(/more than the contract price/);
  });
});

describe("opening balances", () => {
  it("keeps the sign, ignores due dates on credits and checks against the as-of date", () => {
    const { rows, cols } = table(
      "opening_balances",
      "mobile,account,amount,due_date\n09170000001,Boundary,\"2,100.00\",2026-09-01\n09170000001,costs,(500),2026-09-10\n09170000002,hulog,0,\n09170000003,boundary,100,2026-10-05\n09170000004,savings,100,\n",
    );
    const out = validateOpeningBalanceRows(rows, cols, ctx);
    expect(out[0].data).toMatchObject({ account: "boundary", amount: pesos(2100), dueDate: "2026-09-01" });
    expect(out[1].data).toMatchObject({ account: "charges", amount: -pesos(500), dueDate: null });
    expect(out[2].error).toMatch(/zero/);
    expect(out[3].error).toMatch(/after the as-of date/);
    expect(out[4].error).toMatch(/not a valid account/);
  });
  it("warns about rows that look duplicated but allows several rows per account", () => {
    const { rows, cols } = table("opening_balances", "mobile,account,amount,due_date\n09170000001,boundary,700,2026-08-01\n09170000001,boundary,700,2026-09-01\n09170000001,boundary,700,2026-09-01\n");
    const out = validateOpeningBalanceRows(rows, cols, ctx);
    expect(out.every((r) => !r.error)).toBe(true);
    expect(out[2].warnings[0]).toMatch(/line 3/);
  });
});

describe("payments before go-live", () => {
  it("parses methods and refuses dates after the as-of date", () => {
    const { rows, cols } = table("legacy_payments", "mobile,paid_on,amount,method,reference\n09170000001,9/29/2026,700,G-Cash,123\n09170000001,2026-10-01,700,cash,\n09170000001,2026-09-01,-5,cash,\n");
    const out = validateLegacyPaymentRows(rows, cols, ctx);
    expect(out[0].data).toMatchObject({ paidOn: "2026-09-29", method: "gcash", referenceNo: "123", account: null });
    expect(out[1].error).toMatch(/after the as-of date/);
    expect(out[2].error).toMatch(/more than ₱0.00/);
  });
});

describe("employees", () => {
  it("parses rates and flags", () => {
    const { rows, cols } = table("employees", "employee_no,name,hire_date,basis,rate,allowance_taxable,separation_date\nE-1,Ana Reyes,2024-01-15,monthly,\"25,000\",yes,\nE-2,Ben Cruz,2024-01-15,daily,610,,2025-01-01\ne-1,Dup Person,2024-01-15,monthly,1,,\n");
    const out = validateEmployeeRows(rows, cols, ctx);
    expect(out[0].data).toMatchObject({ firstName: "Ana", lastName: "Reyes", rate: pesos(25_000), allowanceTaxable: true, status: "active" });
    expect(out[1].data).toMatchObject({ basis: "daily", status: "inactive" });
    expect(out[2].error).toBe("Same employee number as line 2.");
  });
});

describe("investors", () => {
  it("splits plate lists and refuses a vehicle listed twice", () => {
    const { rows, cols } = table("investors", "name,vehicles\nRamon Uy,\"NBC 1; NBC 2\"\nLiza Tan,nbc-2\n");
    const out = validateInvestorRows(rows, cols);
    expect(out[0].data?.plates.map((p) => p.plateNo)).toEqual(["NBC 1", "NBC 2"]);
    expect(out[1].error).toBe("Vehicle NBC-2 is also listed on line 2.");
  });
});
