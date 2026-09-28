import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  appSettings,
  applicationPayments,
  applications,
  applicationTypes,
  clients,
  driverAccounts,
  drivers,
  paymentLines,
  payments,
  paymentVoids,
  profiles,
} from "@/db/schema";
import { formatPeso } from "@/lib/money";

const LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;
const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
const DATE = new Intl.DateTimeFormat("en-PH", { timeZone: "UTC", dateStyle: "medium" });
// PDF built-in fonts have no ₱ sign.
const php = (v: bigint) => `PHP ${formatPeso(v, { symbol: false })}`;

const s = StyleSheet.create({
  page: { padding: 28, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  center: { textAlign: "center" },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", textAlign: "center" },
  muted: { color: "#666" },
  title: { marginTop: 8, fontFamily: "Helvetica-Bold", textAlign: "center", letterSpacing: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  total: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#333", marginTop: 4, paddingTop: 4, fontFamily: "Helvetica-Bold" },
  void: { marginTop: 6, color: "#b91c1c", fontFamily: "Helvetica-Bold", textAlign: "center" },
});

export type AckReceipt = {
  company: { name: string; address?: string; phone?: string };
  receiptNo: string;
  receivedFrom: string;
  date: string;
  method: string;
  reference: string | null;
  receivedBy: string;
  lines: { label: string; amount: bigint }[];
  total: bigint;
  voidReason: string | null;
  extra?: string;
};

/** Acknowledgement receipt PDF (A6): owner rule, acknowledgement receipts only (not BIR official receipts). */
export async function renderAckReceipt(r: AckReceipt): Promise<Buffer> {
  const doc = (
    <Document title={`Acknowledgement receipt ${r.receiptNo}`}>
      <Page size="A6" style={s.page}>
        <Text style={s.h1}>{r.company.name}</Text>
        {r.company.address ? <Text style={[s.center, s.muted]}>{r.company.address}</Text> : null}
        {r.company.phone ? <Text style={[s.center, s.muted]}>{r.company.phone}</Text> : null}
        <Text style={s.title}>ACKNOWLEDGEMENT RECEIPT</Text>
        <Text style={s.center}>{r.receiptNo}</Text>
        {r.voidReason ? <Text style={s.void}>VOID: {r.voidReason}</Text> : null}
        <View style={{ marginTop: 10 }}>
          <View style={s.row}><Text style={s.muted}>Received from</Text><Text>{r.receivedFrom}</Text></View>
          <View style={s.row}><Text style={s.muted}>Date</Text><Text>{r.date}</Text></View>
          <View style={s.row}><Text style={s.muted}>Method</Text><Text>{r.method}{r.reference ? ` · ${r.reference}` : ""}</Text></View>
          <View style={s.row}><Text style={s.muted}>Received by</Text><Text>{r.receivedBy || "TransRev"}</Text></View>
          {r.extra ? <View style={s.row}><Text style={s.muted}>For</Text><Text>{r.extra}</Text></View> : null}
        </View>
        <View style={{ marginTop: 10 }}>
          {r.lines.map((l) => (
            <View key={l.label} style={s.row}><Text>{l.label}</Text><Text>{php(l.amount)}</Text></View>
          ))}
          <View style={s.total}><Text>Total</Text><Text>{php(r.total)}</Text></View>
        </View>
        <Text style={[s.center, s.muted, { marginTop: 14, fontSize: 8 }]}>This is an acknowledgement receipt, not an official receipt.</Text>
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}

async function company(tx: Tx): Promise<AckReceipt["company"]> {
  const [c] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
  return (c?.value ?? { name: "TransRev" }) as AckReceipt["company"];
}

/** Driver payment receipt. Runs under RLS: drivers only get their own payments. */
export async function renderReceiptPdf(tx: Tx, paymentId: string): Promise<{ pdf: Buffer; receiptNo: string } | null> {
  const [row] = await tx
    .select({ p: payments, d: drivers, collector: profiles.fullName })
    .from(payments)
    .innerJoin(drivers, eq(drivers.id, payments.driverId))
    // Drivers can't read staff profiles (RLS), so the collector's name may be missing.
    .leftJoin(profiles, eq(profiles.id, payments.collectorId))
    .where(eq(payments.id, paymentId));
  if (!row) return null;
  const lines = await tx
    .select({ amount: paymentLines.amountCentavos, kind: driverAccounts.kind })
    .from(paymentLines)
    .innerJoin(driverAccounts, eq(driverAccounts.id, paymentLines.accountId))
    .where(eq(paymentLines.paymentId, paymentId));
  const [voided] = await tx.select().from(paymentVoids).where(eq(paymentVoids.paymentId, paymentId));
  const { p, d } = row;
  const pdf = await renderAckReceipt({
    company: await company(tx),
    receiptNo: p.receiptNo,
    receivedFrom: `${d.firstName} ${d.lastName}`,
    date: TIME.format(p.receivedAt),
    method: p.method.replace("_", " "),
    reference: p.referenceNo ? `${p.bankName ? `${p.bankName} ` : ""}${p.referenceNo}` : null,
    receivedBy: row.collector ?? "",
    lines: lines.map((l) => ({ label: LABEL[l.kind], amount: l.amount })),
    total: p.amountCentavos,
    voidReason: voided?.reason ?? null,
  });
  return { pdf, receiptNo: p.receiptNo };
}

/** Application fee payment receipt (same AR number series). */
export async function renderApplicationReceiptPdf(tx: Tx, paymentId: string): Promise<{ pdf: Buffer; receiptNo: string } | null> {
  const [row] = await tx
    .select({ p: applicationPayments, appNo: applications.appNo, type: applicationTypes.label, client: clients.name, by: profiles.fullName })
    .from(applicationPayments)
    .innerJoin(applications, eq(applications.id, applicationPayments.applicationId))
    .innerJoin(applicationTypes, eq(applicationTypes.key, applications.typeKey))
    .innerJoin(clients, eq(clients.id, applications.clientId))
    .leftJoin(profiles, eq(profiles.id, applicationPayments.receivedBy))
    .where(eq(applicationPayments.id, paymentId));
  if (!row) return null;
  const { p } = row;
  const pdf = await renderAckReceipt({
    company: await company(tx),
    receiptNo: p.receiptNo,
    receivedFrom: row.client,
    date: DATE.format(new Date(`${p.receivedOn}T00:00:00Z`)),
    method: p.method.replace("_", " "),
    reference: p.referenceNo ? `${p.bankName ? `${p.bankName} ` : ""}${p.referenceNo}` : null,
    receivedBy: row.by ?? "",
    lines: [{ label: `${row.type} (${row.appNo})`, amount: p.amountCentavos }],
    total: p.amountCentavos,
    voidReason: p.voidReason ?? null,
    extra: row.appNo,
  });
  return { pdf, receiptNo: p.receiptNo };
}
