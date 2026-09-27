import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, drivers } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { formatPeso } from "@/lib/money";
import { getDriverStatements } from "@/server/money/payments";

const ACCOUNT_LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;
const TYPE_LABEL: Record<string, string> = {
  opening_balance: "Opening balance", boundary_charge: "Boundary", amortization_charge: "Amortization",
  cost_charge: "Driver cost", deposit_charge: "Deposit", payment: "Payment", bonus_credit: "Bonus credit",
  adjustment: "Adjustment", reversal: "Reversal",
};

// PDF fonts don't include ₱ by default; use "PHP" in the PDF.
const php = (v: bigint) => formatPeso(v, { symbol: false }).replace(/^-/, "-PHP ").replace(/^(?!-)/, "PHP ");

const s = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 4 },
  muted: { color: "#666" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#ddd", paddingVertical: 3 },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  cDate: { width: 60 }, cDesc: { flex: 1 }, cNum: { width: 75, textAlign: "right" },
  summary: { flexDirection: "row", gap: 16, marginTop: 10 },
  box: { borderWidth: 0.5, borderColor: "#999", padding: 6, flex: 1 },
});

/** Statement of account for a period, with balance brought forward. Runs under RLS. */
export async function renderStatementPdf(tx: Tx, driverId: string, from: IsoDate, to: IsoDate): Promise<Buffer | null> {
  const [driver] = await tx.select().from(drivers).where(eq(drivers.id, driverId));
  if (!driver) return null;
  const [company] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
  const companyName = (company?.value as { name?: string } | undefined)?.name ?? "TransRev";
  const statements = await getDriverStatements(tx, driverId);
  const total = statements.reduce((t, st) => t + st.allocation.balance, BigInt(0));

  const doc = (
    <Document title={`Statement of account – ${driver.firstName} ${driver.lastName}`}>
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>{companyName}</Text>
        <Text style={{ fontSize: 11, marginTop: 4 }}>Statement of account</Text>
        <Text style={s.muted}>
          {driver.firstName} {driver.lastName} · {driver.phone} · Period {from} to {to}
        </Text>
        <View style={s.summary}>
          {statements.map((st) => (
            <View key={st.account.id} style={s.box}>
              <Text style={s.muted}>{ACCOUNT_LABEL[st.account.kind]}</Text>
              <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{php(st.allocation.balance)}</Text>
            </View>
          ))}
          <View style={s.box}>
            <Text style={s.muted}>Total balance today</Text>
            <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{php(total)}</Text>
          </View>
        </View>
        {statements.map((st) => {
          const before = st.entries.filter((e) => e.businessDate < from).reduce((t, e) => t + e.amountCentavos, BigInt(0));
          let running = before;
          const inPeriod = st.entries.filter((e) => e.businessDate >= from && e.businessDate <= to);
          return (
            <View key={st.account.id} wrap>
              <Text style={s.h2}>{ACCOUNT_LABEL[st.account.kind]}</Text>
              <View style={s.head}>
                <Text style={s.cDate}>Date</Text>
                <Text style={s.cDesc}>Description</Text>
                <Text style={s.cNum}>Charge</Text>
                <Text style={s.cNum}>Credit</Text>
                <Text style={s.cNum}>Balance</Text>
              </View>
              <View style={s.row}>
                <Text style={s.cDate}>{from}</Text>
                <Text style={s.cDesc}>Balance brought forward</Text>
                <Text style={s.cNum} />
                <Text style={s.cNum} />
                <Text style={s.cNum}>{php(before)}</Text>
              </View>
              {inPeriod.map((e) => {
                running += e.amountCentavos;
                return (
                  <View key={e.id} style={s.row} wrap={false}>
                    <Text style={s.cDate}>{e.businessDate}</Text>
                    <Text style={s.cDesc}>
                      {TYPE_LABEL[e.entryType]}
                      {e.memo ? ` – ${e.memo}` : ""}
                    </Text>
                    <Text style={s.cNum}>{e.amountCentavos > BigInt(0) ? php(e.amountCentavos) : ""}</Text>
                    <Text style={s.cNum}>{e.amountCentavos < BigInt(0) ? php(-e.amountCentavos) : ""}</Text>
                    <Text style={s.cNum}>{php(running)}</Text>
                  </View>
                );
              })}
            </View>
          );
        })}
        <Text style={[s.muted, { marginTop: 16 }]}>
          Payments are applied to the oldest unpaid dues first within each account. This statement is computed from the ledger.
        </Text>
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}
