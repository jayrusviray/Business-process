import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import {
  addApplicationFee,
  applicationMoney,
  attachChecklistDocument,
  convertLeadToApplication,
  createApplication,
  createDriverFromApplication,
  findOrCreateClient,
  recordApplicationPayment,
  setApplicationStatus,
  verifyChecklistItem,
  voidApplicationPayment,
} from "@/server/applications/service";
import { createLead } from "@/server/crm/leads";
import { approveApplicationCommission, payApplicationCommission } from "@/server/office/commissions";
import { renderApplicationReceiptPdf } from "@/server/pdf/receipt";
import { submitPublicApplication } from "@/server/public/apply";
import { hashIp } from "@/server/public/inquiry";
import { expiringDocuments } from "@/server/queries/applications";
import { as, schema, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { applications, applicationTypes, applicationCommissionRules, applicationChecklistItems, applicationCommissions, documents, leads, vehicles, franchises } = schema;
let admin: string, finance: string, ops: string, sales: string, docs: string, driverUser: string;
const mobile = () => `0918${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const TODAY = isoDate("2026-10-20");

async function newApp(actor: string, typeKey = "ltfrb_cpc_renewal", extra: Partial<Parameters<typeof createApplication>[1]> = {}) {
  return withUserTx(as(actor), async (tx) => {
    const c = await findOrCreateClient(tx, { name: "Operator Test", mobile: mobile() });
    return createApplication(tx, { typeKey, clientId: c.id, source: "staff", ...extra });
  });
}

beforeAll(async () => {
  admin = await createUser("A Admin", ["owner_admin"]);
  finance = await createUser("A Finance", ["finance"]);
  ops = await createUser("A Ops", ["operations"]);
  sales = await createUser("A Sales", ["sales"]);
  docs = await createUser("A Docs", ["documentation"]);
  driverUser = await createUser("A Driver", ["driver"]);
});

afterAll(async () => {
  await sql.end();
});

describe("documentation role", () => {
  it("is staff: sees applications and colleagues, not leads or money screens' data", async () => {
    const app = await newApp(docs);
    expect(await withUserTx(as(docs), (tx) => tx.select().from(applications).where(eq(applications.id, app.id)))).toHaveLength(1);
    // is_staff(): documentation staff can see colleagues' profiles.
    const seen = await withUserTx(as(docs), (tx) => tx.select().from(schema.profiles).where(eq(schema.profiles.id, finance)));
    expect(seen).toHaveLength(1);
    const lead = await withUserTx(as(sales), (tx) => createLead(tx, { name: "Hidden", mobile: mobile(), source: "messenger", interest: "franchise", assignedTo: sales }));
    expect(await withUserTx(as(docs), (tx) => tx.select().from(leads).where(eq(leads.id, lead.id)))).toEqual([]);
    expect(await withUserTx(as(driverUser), (tx) => tx.select().from(applications).where(eq(applications.id, app.id)))).toEqual([]);
  });
});

describe("opening applications", () => {
  it("copies the checklist and quotes the default fee (staff only)", async () => {
    await withUserTx(as(admin), (tx) => tx.update(applicationTypes).set({ defaultFeeCentavos: pesos(8500) }).where(eq(applicationTypes.key, "ltfrb_cpc_renewal")));
    const app = await newApp(ops);
    const items = await sql`SELECT label, required FROM public.application_checklist_items WHERE application_id = ${app.id} ORDER BY sort`;
    expect(items.length).toBe(3);
    const money = await withUserTx(as(ops), (tx) => applicationMoney(tx, app.id));
    expect([money.charged, money.paid, money.balance]).toEqual([pesos(8500), BigInt(0), pesos(8500)]);
    expect(app.appNo).toMatch(/^APP-\d{6}$/);
    const none = await newApp(ops, "ltfrb_cpc_renewal", { quotedFee: BigInt(0) });
    expect((await withUserTx(as(ops), (tx) => applicationMoney(tx, none.id))).charged).toBe(BigInt(0));
    const [hist] = await sql`SELECT from_key, to_key, changed_by FROM public.application_status_history WHERE application_id = ${app.id}`;
    expect(hist).toEqual({ from_key: null, to_key: "inquiry", changed_by: ops });
  });

  it("converts a lead: reuses the client with the same mobile and marks the lead converted", async () => {
    const m = mobile();
    const existing = await withUserTx(as(ops), (tx) => findOrCreateClient(tx, { name: "Same Person", mobile: m }));
    const lead = await withUserTx(as(sales), (tx) =>
      createLead(tx, { name: "Same Person", mobile: `+63${m.slice(1)}`, source: "messenger", interest: "activation", assignedTo: sales, referrerName: "Kuya Ref" }),
    );
    const app = await withUserTx(as(sales), (tx) => convertLeadToApplication(tx, { leadId: lead.id, typeKey: "platform_activation", assignedTo: docs }));
    const [a] = await sql`SELECT client_id, lead_id, referrer_name, assigned_to FROM public.applications WHERE id = ${app.id}`;
    expect(a).toEqual({ client_id: existing.id, lead_id: lead.id, referrer_name: "Kuya Ref", assigned_to: docs });
    const [l] = await sql`SELECT stage_key, converted_at IS NOT NULL AS won FROM public.leads WHERE id = ${lead.id}`;
    expect(l).toEqual({ stage_key: "converted", won: true });
    const [act] = await sql`SELECT body FROM public.lead_activities WHERE lead_id = ${lead.id} AND kind = 'converted'`;
    expect(act.body).toContain(app.appNo);
  });
});

describe("status pipeline", () => {
  it("logs history with notes, needs a reason to cancel, and stamps approval once", async () => {
    const app = await newApp(docs);
    await withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "filed", note: "Filed at LTFRB NCR" }));
    await expectDbError(withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "cancelled" })), /Why is this application cancelled/);
    await expectDbError(withUserTx(as(docs), (tx) => tx.update(applications).set({ statusKey: "cancelled" }).where(eq(applications.id, app.id))), /give a reason/);
    await withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "approved" }));
    const [first] = await sql`SELECT approved_at FROM public.applications WHERE id = ${app.id}`;
    await withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "completed" }));
    const [after] = await sql`SELECT approved_at, completed_at IS NOT NULL AS done FROM public.applications WHERE id = ${app.id}`;
    expect(after.approved_at).toEqual(first.approved_at);
    expect(after.done).toBe(true);
    const hist = await sql`SELECT from_key, to_key, note, changed_by FROM public.application_status_history WHERE application_id = ${app.id} ORDER BY changed_at, to_key`;
    expect(hist.map((h) => [h.from_key, h.to_key, h.note])).toEqual([
      [null, "inquiry", ""],
      ["inquiry", "filed", "Filed at LTFRB NCR"],
      ["filed", "approved", ""],
      ["approved", "completed", ""],
    ]);
    await expectDbError(sql`UPDATE public.application_status_history SET note = 'x' WHERE application_id = ${app.id}`, /append-only/);
    await expectDbError(sql`DELETE FROM public.applications WHERE id = ${app.id}`, /append-only/);
  });
});

describe("checklist", () => {
  it("documentation uploads and verifies; a new file clears the verification; sales can't verify", async () => {
    const app = await newApp(docs);
    const [item] = await sql`SELECT id FROM public.application_checklist_items WHERE application_id = ${app.id} ORDER BY sort LIMIT 1`;
    const docId = async () =>
      withUserTx(as(docs), async (tx) => {
        const [d] = await tx
          .insert(documents)
          .values({ ownerType: "application", ownerId: app.id, docType: "checklist", storagePath: `application/${app.id}/${crypto.randomUUID()}.pdf`, fileName: "cpc.pdf", mimeType: "application/pdf", sizeBytes: 1, uploadedBy: docs })
          .returning({ id: documents.id });
        return d.id;
      });
    const d1 = await docId();
    await withUserTx(as(docs), (tx) => attachChecklistDocument(tx, { itemId: item.id, documentId: d1 }));
    await expectDbError(withUserTx(as(sales), (tx) => verifyChecklistItem(tx, { itemId: item.id, actorId: sales, verified: true })), /not allowed/);
    await withUserTx(as(docs), (tx) => verifyChecklistItem(tx, { itemId: item.id, actorId: docs, verified: true }));
    const [v] = await sql`SELECT verified_by, submitted_at IS NOT NULL AS got FROM public.application_checklist_items WHERE id = ${item.id}`;
    expect(v).toEqual({ verified_by: docs, got: true });
    const d2 = await docId();
    await withUserTx(as(docs), (tx) => attachChecklistDocument(tx, { itemId: item.id, documentId: d2 }));
    const [r] = await sql`SELECT verified_at, document_id FROM public.application_checklist_items WHERE id = ${item.id}`;
    expect(r).toEqual({ verified_at: null, document_id: d2 });
    await expectDbError(withUserTx(as(docs), (tx) => tx.delete(applicationChecklistItems).where(eq(applicationChecklistItems.id, item.id))), /permission denied|append-only/);
  });
});

describe("fees, payments and receipts", () => {
  it("records payments once per request, voids instead of editing, and shares the AR series", async () => {
    const app = await newApp(docs, "ltfrb_pa_new", { quotedFee: pesos(5000) });
    const req = crypto.randomUUID();
    const pay = (actor: string) =>
      withUserTx(as(actor), (tx) =>
        recordApplicationPayment(tx, { applicationId: app.id, amount: pesos(2000), method: "gcash", referenceNo: "GC-1", receivedOn: TODAY, receivedBy: actor, clientRequestId: req }),
      );
    await expectDbError(pay(sales), /row-level security/);
    const p1 = await pay(finance);
    const p2 = await pay(finance);
    expect(p2).toEqual({ ...p1, duplicate: true });
    expect(p1.receiptNo).toMatch(/^AR-\d{6}$/);
    await expectDbError(
      withUserTx(as(finance), (tx) =>
        recordApplicationPayment(tx, { applicationId: app.id, amount: pesos(1), method: "maya", receivedOn: TODAY, receivedBy: finance, clientRequestId: crypto.randomUUID() }),
      ),
      /reference number is required/,
    );
    await withUserTx(as(docs), (tx) => addApplicationFee(tx, { applicationId: app.id, description: "LTFRB filing fee", amount: pesos(510) }));
    let m = await withUserTx(as(finance), (tx) => applicationMoney(tx, app.id));
    expect([m.charged, m.paid, m.balance]).toEqual([pesos(5510), pesos(2000), pesos(3510)]);
    await expectDbError(sql`UPDATE public.application_payments SET amount_centavos = 1 WHERE id = ${p1.id}`, /only be voided/);
    await expectDbError(withUserTx(as(docs), (tx) => voidApplicationPayment(tx, { id: p1.id, reason: "typo", userId: docs })), /not found|already void/);
    await withUserTx(as(finance), (tx) => voidApplicationPayment(tx, { id: p1.id, reason: "Wrong reference", userId: finance }));
    m = await withUserTx(as(finance), (tx) => applicationMoney(tx, app.id));
    expect(m.balance).toBe(pesos(5510));
    const pdf = await withUserTx(as(finance), (tx) => renderApplicationReceiptPdf(tx, p1.id));
    expect(pdf?.pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(await withUserTx(as(driverUser), (tx) => renderApplicationReceiptPdf(tx, p1.id))).toBeNull();
  });
});

describe("referral commissions", () => {
  it("are created once on approval when a rule and a referrer exist; amounts are locked", async () => {
    await withUserTx(as(admin), (tx) =>
      tx.insert(applicationCommissionRules).values({ typeKey: "ltfrb_extension", mode: "percent", rateBps: 1000, active: true }),
    );
    const app = await newApp(docs, "ltfrb_extension", { quotedFee: pesos(4000), referrerName: "Mang Kanor", referrerPhone: "09171112222" });
    const r1 = await withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "approved" }));
    expect(r1.commissionId).not.toBeNull();
    const r2 = await withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "completed" }));
    expect(r2.commissionId).toBeNull();
    const [c] = await sql`SELECT base_centavos, amount_centavos, status FROM public.application_commissions WHERE application_id = ${app.id}`;
    expect(c).toEqual({ base_centavos: "400000", amount_centavos: "40000", status: "pending" });
    await expectDbError(sql`UPDATE public.application_commissions SET amount_centavos = 1 WHERE application_id = ${app.id}`, /cannot change/);
    await expectDbError(withUserTx(as(docs), (tx) => approveApplicationCommission(tx, r1.commissionId!, docs)), /not found|not pending/);
    await withUserTx(as(finance), (tx) => approveApplicationCommission(tx, r1.commissionId!, finance));
    await withUserTx(as(finance), (tx) => payApplicationCommission(tx, r1.commissionId!, TODAY, "GCash 123"));
    const [paid] = await withUserTx(as(finance), (tx) => tx.select().from(applicationCommissions).where(eq(applicationCommissions.id, r1.commissionId!)));
    expect(paid.status).toBe("paid");
    // No referrer or no rule → nothing.
    const plain = await newApp(docs, "ltfrb_extension", { quotedFee: pesos(4000) });
    expect((await withUserTx(as(docs), (tx) => setApplicationStatus(tx, { applicationId: plain.id, statusKey: "approved" }))).commissionId).toBeNull();
  });
});

describe("driver program", () => {
  it("an approved application becomes a driver profile (once)", async () => {
    const m = mobile();
    const app = await withUserTx(as(ops), async (tx) => {
      const c = await findOrCreateClient(tx, { name: "Maria Clara de los Santos", mobile: m, email: "mc@example.com" });
      return createApplication(tx, { typeKey: "driver_program", clientId: c.id, source: "staff" });
    });
    await expectDbError(withUserTx(as(ops), (tx) => createDriverFromApplication(tx, app.id)), /Approve the application first/);
    await withUserTx(as(ops), (tx) => setApplicationStatus(tx, { applicationId: app.id, statusKey: "approved" }));
    const d = await withUserTx(as(ops), (tx) => createDriverFromApplication(tx, app.id));
    expect(d.created).toBe(true);
    const [drv] = await sql`SELECT first_name, last_name, phone, status FROM public.drivers WHERE id = ${d.driverId}`;
    expect(drv).toEqual({ first_name: "Maria Clara", last_name: "de los Santos", phone: m, status: "applicant" });
    expect(await withUserTx(as(ops), (tx) => createDriverFromApplication(tx, app.id))).toEqual({ driverId: d.driverId, created: false });
    const [cl] = await sql`SELECT c.driver_id FROM public.clients c JOIN public.applications a ON a.client_id = c.id WHERE a.id = ${app.id}`;
    expect(cl.driver_id).toBe(d.driverId);
    const other = await newApp(ops, "platform_activation");
    await withUserTx(as(ops), (tx) => setApplicationStatus(tx, { applicationId: other.id, statusKey: "approved" }));
    await expectDbError(withUserTx(as(ops), (tx) => createDriverFromApplication(tx, other.id)), /Only driver program/);
  });
});

describe("online applications (/apply)", () => {
  it("creates a lead, a client and a draft application, and notifies documentation staff", async () => {
    const m = mobile();
    const res = await submitPublicApplication(
      { typeKey: "driver_program", name: "Online Applicant", mobile: m, email: null, address: "Caloocan", preferredContact: "sms", message: "May prof license po" },
      hashIp(`198.51.100.${Math.floor(Math.random() * 200)}`),
    );
    const [a] = await sql`
      SELECT a.source, a.status_key, a.lead_id IS NOT NULL AS has_lead, c.mobile, l.source AS lead_source, l.interest
      FROM public.applications a JOIN public.clients c ON c.id = a.client_id JOIN public.leads l ON l.id = a.lead_id
      WHERE a.id = ${res.applicationId}`;
    expect(a).toEqual({ source: "public", status_key: "inquiry", has_lead: true, mobile: m, lead_source: "landing_page", interest: "vehicle_program" });
    const [n] = await sql`SELECT count(*)::int AS n FROM public.notifications WHERE user_id = ${docs} AND link = ${`/app/applications/${res.applicationId}`}`;
    expect(n.n).toBe(1);
    const fees = await sql`SELECT count(*)::int AS n FROM public.application_fees WHERE application_id = ${res.applicationId}`;
    expect(fees[0].n).toBe(0);
    await expect(
      submitPublicApplication({ typeKey: "nope", name: "X", mobile: m, email: null, address: "", preferredContact: "call", message: "" }, hashIp("203.0.113.250")),
    ).rejects.toThrow(/unknown application type/);
  });
});

describe("vehicle papers", () => {
  it("derives is_ev from powertrain and lists OR/CR, insurance and franchise expiries", async () => {
    const [v] = await withUserTx(as(ops), (tx) =>
      tx
        .insert(vehicles)
        .values({ plateNo: `EXP ${Math.floor(Math.random() * 1e6)}`, make: "BYD", model: "e6", powertrain: "ev", orcrExpiresOn: "2026-11-05", insuranceExpiresOn: "2027-06-01" })
        .returning(),
    );
    expect(v.isEv).toBe(true);
    await expectDbError(sql`UPDATE public.vehicles SET is_ev = false WHERE id = ${v.id}`, /can only be updated to DEFAULT|generated/);
    const client = await withUserTx(as(ops), (tx) => findOrCreateClient(tx, { name: "Franchise Holder", mobile: mobile() }));
    await withUserTx(as(ops), (tx) => tx.insert(franchises).values({ vehicleId: v.id, operatorName: "Franchise Holder", clientId: client.id, kind: "CPC", number: "CPC-EXP-1", expiresOn: "2026-12-10" }));
    const res = await withUserTx(as(ops), (tx) => expiringDocuments(tx, TODAY));
    const mine = res.rows.filter((r) => r.vehicle_id === v.id).map((r) => [r.kind, r.expires_on, r.client_name]);
    expect(mine).toEqual([
      ["orcr", "2026-11-05", null],
      ["franchise", "2026-12-10", "Franchise Holder"],
    ]);
    expect([res.warnDays, res.urgentDays]).toEqual([60, 30]);
  });
});
