import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import { postBoundaryCharges } from "@/server/money/charges";
import { startBoundaryPlan } from "@/server/money/fleet";
import { generateReminders, markMessage, queueManualMessage } from "@/server/reminders";
import { as, schema, withSystemTx, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { drivers, messageOptOuts, messages, messageTemplates } = schema;
const D = isoDate;
let admin: string, ops: string, driverUser: string;

async function driverWithDebt(phone: string, language: "en" | "taglish" = "taglish") {
  return withUserTx(as(ops), async (tx) => {
    const [d] = await tx
      .insert(drivers)
      .values({ firstName: "Rem", lastName: phone, phone, status: "active", preferredLanguage: language, licenseExpiry: "2031-01-20" })
      .returning({ id: drivers.id });
    await startBoundaryPlan(tx, { driverId: d.id, programType: "boundary", dailyRate: pesos(700), effectiveFrom: D("2031-01-05") }, D("2031-01-05"));
    return d.id;
  });
}

beforeAll(async () => {
  admin = await createUser("M Admin", ["owner_admin"]);
  ops = await createUser("M Ops", ["operations"]);
  driverUser = await createUser("M Driver", ["driver"]);
});
afterAll(async () => {
  await sql.end();
});

describe("reminder generation (manual send)", () => {
  it("queues the right reminders in the driver's language, once", async () => {
    const d = await driverWithDebt("09173330001", "taglish");
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2031-01-05"))); // Sunday, unpaid
    // Monday 2031-01-06: weekly balance + missed boundary for Jan 5 + license (expires in 14 days).
    const r1 = await withSystemTx("cron:reminders", (tx) => generateReminders(tx, D("2031-01-06")));
    expect(r1.errors).toEqual([]);
    const rows = await sql`SELECT trigger, body, status, channel FROM public.messages WHERE driver_id = ${d} ORDER BY trigger`;
    expect(rows.map((r) => r.trigger).sort()).toEqual(["balance_weekly", "license_expiry", "missed_boundary"]);
    expect(rows.find((r) => r.trigger === "missed_boundary")!.body).toBe(
      "Hi Rem, hindi pa fully paid ang boundary mo na P700.00 para sa Jan 5, 2031. Total balance: P700.00. - TransRev",
    );
    expect(rows.every((r) => r.status === "pending" && r.channel === "sms_manual")).toBe(true);
    await withSystemTx("cron:reminders", (tx) => generateReminders(tx, D("2031-01-06")));
    const again = await sql`SELECT count(*)::int n FROM public.messages WHERE driver_id = ${d}`;
    expect(again[0].n).toBe(3);
  });

  it("skips opted-out numbers", async () => {
    const d = await driverWithDebt("09173330002", "en");
    await withUserTx(as(ops), (tx) => tx.insert(messageOptOuts).values({ phone: "09173330002", reason: "asked by driver" }));
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2031-01-05")));
    await withSystemTx("cron:reminders", (tx) => generateReminders(tx, D("2031-01-06")));
    const rows = await sql`SELECT 1 FROM public.messages WHERE driver_id = ${d}`;
    expect(rows).toHaveLength(0);
    await expect(withUserTx(as(ops), (tx) => queueManualMessage(tx, { driverId: d, body: "hello" }))).rejects.toThrow(/opted out/);
  });

  it("staff mark messages sent once; the text can't be changed; nothing can be deleted", async () => {
    const d = await driverWithDebt("09173330003", "en");
    const id = await withUserTx(as(ops), (tx) => queueManualMessage(tx, { driverId: d, body: "Please visit the office tomorrow." }));
    await withUserTx(as(ops), (tx) => markMessage(tx, id, "sent"));
    const [m] = await sql`SELECT status, handled_by, handled_at IS NOT NULL AS handled FROM public.messages WHERE id = ${id}`;
    expect(m).toEqual({ status: "sent", handled_by: ops, handled: true });
    await expectDbError(withUserTx(as(ops), (tx) => markMessage(tx, id, "skipped")), /already handled/);
    const id2 = await withUserTx(as(ops), (tx) => queueManualMessage(tx, { driverId: d, body: "x" }));
    await expectDbError(
      withUserTx(as(ops), (tx) => tx.update(messages).set({ body: "changed" }).where(eq(messages.id, id2))),
      /permission denied/,
    );
    await expectDbError(sql`DELETE FROM public.messages WHERE id = ${id2}`, /append-only/);
  });

  it("only owner_admin edits templates; drivers see no messages", async () => {
    const r = await withUserTx(as(ops), (tx) =>
      tx.update(messageTemplates).set({ body: "x" }).where(eq(messageTemplates.key, "balance_weekly")).returning(),
    );
    expect(r).toHaveLength(0);
    const ok = await withUserTx(as(admin), (tx) =>
      tx.update(messageTemplates).set({ body: "Hi {{name}}! Balance: {{balance}}" }).where(dsql`${messageTemplates.key} = 'balance_weekly' AND ${messageTemplates.language} = 'en'`).returning(),
    );
    expect(ok).toHaveLength(1);
    const seen = await withUserTx(as(driverUser), (tx) => tx.execute(dsql`SELECT id FROM public.messages`));
    expect(seen).toHaveLength(0);
  });

  it("a broken template is reported, not sent", async () => {
    await withUserTx(as(admin), (tx) =>
      tx.update(messageTemplates).set({ body: "Hi {{nme}}" }).where(dsql`${messageTemplates.key} = 'license_expiry' AND ${messageTemplates.language} = 'taglish'`),
    );
    await driverWithDebt("09173330004", "taglish");
    const r = await withSystemTx("cron:reminders", (tx) => generateReminders(tx, D("2031-01-07")));
    expect(r.errors.some((e) => e.includes("{{nme}}"))).toBe(true);
    const bad = await sql`SELECT 1 FROM public.messages WHERE body LIKE '%{{%'`;
    expect(bad).toHaveLength(0);
  });
});
