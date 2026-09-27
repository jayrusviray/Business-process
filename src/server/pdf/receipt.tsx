import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, driverAccounts, drivers, paymentLines, payments, paymentVoids, profiles } from "@/db/schema";
import { formatPeso } from "@/lib/money";

const LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;
const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
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

/** Acknowledgement receipt PDF (A6). Runs under RLS: drivers only get their own payments. */
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
  const [company] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
  const c = (company?.value ?? { name: "TransRev" }) as { name: string; address?: string; phone?: string };
  const { p, d } = row;

  const doc = (
    <Document title={`Acknowledgement receipt ${p.receiptNo}`}>
      <Page size="A6" style={s.page}>
        <Text style={s.h1}>{c.name}</Text>
        {c.address ? <Text style={[s.center, s.muted]}>{c.address}</Text> : null}
        {c.phone ? <Text style={[s.center, s.muted]}>{c.phone}</Text> : null}
        <Text style={s.title}>ACKNOWLEDGEMENT RECEIPT</Text>
        <Text style={s.center}>{p.receiptNo}</Text>
        {voided ? <Text style={s.void}>VOID: {voided.reason}</Text> : null}
        <View style={{ marginTop: 10 }}>
          <View style={s.row}><Text style={s.muted}>Received from</Text><Text>{d.firstName} {d.lastName}</Text></View>
          <View style={s.row}><Text style={s.muted}>Date</Text><Text>{TIME.format(p.receivedAt)}</Text></View>
          <View style={s.row}>
            <Text style={s.muted}>Method</Text>
            <Text>{p.method.replace("_", " ")}{p.referenceNo ? ` · ${p.bankName ? `${p.bankName} ` : ""}${p.referenceNo}` : ""}</Text>
          </View>
          <View style={s.row}><Text style={s.muted}>Received by</Text><Text>{row.collector || "TransRev"}</Text></View>
        </View>
        <View style={{ marginTop: 10 }}>
          {lines.map((l) => (
            <View key={l.kind} style={s.row}><Text>{LABEL[l.kind]}</Text><Text>{php(l.amount)}</Text></View>
          ))}
          <View style={s.total}><Text>Total</Text><Text>{php(p.amountCentavos)}</Text></View>
        </View>
        <Text style={[s.center, s.muted, { marginTop: 14, fontSize: 8 }]}>This is an acknowledgement receipt, not an official receipt.</Text>
      </Page>
    </Document>
  );
  return { pdf: await renderToBuffer(doc), receiptNo: p.receiptNo };
}
