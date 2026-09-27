import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, drivers, vehicles } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { formatPeso } from "@/lib/money";
import { getRtoStatus } from "@/server/money/rto";

const php = (v: bigint) => `PHP ${formatPeso(v, { symbol: false })}`;
const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica" },
  h1: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#ccc" },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, marginTop: 4, borderTopWidth: 1.5, fontFamily: "Helvetica-Bold", fontSize: 12 },
  muted: { color: "#666" },
});

/** Cashout (early buyout) statement. Owner rule: remaining principal only, no discounts or fees. */
export async function renderCashoutPdf(tx: Tx, contractId: string, asOf: IsoDate): Promise<Buffer | null> {
  const st = await getRtoStatus(tx, contractId, asOf);
  if (!st) return null;
  const { contract: c, quote, progress } = st;
  const [d] = await tx.select().from(drivers).where(eq(drivers.id, c.driverId));
  const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, c.vehicleId));
  const [company] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
  const name = (company?.value as { name?: string } | undefined)?.name ?? "TransRev";
  const line = (label: string, value: bigint) => (
    <View style={s.row}>
      <Text>{label}</Text>
      <Text>{php(value)}</Text>
    </View>
  );
  return renderToBuffer(
    <Document title={`Cashout statement ${c.contractNo}`}>
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>{name}</Text>
        <Text style={{ fontSize: 12, marginTop: 6 }}>Cashout (early buyout) statement</Text>
        <Text style={[s.muted, { marginBottom: 16 }]}>
          {c.contractNo} · as of {asOf}
        </Text>
        <Text>Driver: {d?.firstName} {d?.lastName} ({d?.phone})</Text>
        <Text>Vehicle: {v?.plateNo} · {v?.make} {v?.model} {v?.year ?? ""}</Text>
        <Text style={{ marginBottom: 12 }}>Contract start: {c.startDate} · Term: {c.termMonths} months · Status: {c.status}</Text>
        {line("Contract price", c.contractPriceCentavos)}
        {line("Total paid toward the vehicle", progress.paid)}
        {line("Remaining principal", quote.remainingPrincipal)}
        {line("  of which past due", quote.arrears)}
        {line("Discount", quote.discount)}
        {line("Fees", quote.fees)}
        <View style={s.total}>
          <Text>Amount to pay for full ownership</Text>
          <Text>{php(quote.payoff)}</Text>
        </View>
        <Text style={[s.muted, { marginTop: 18 }]}>
          No interest applies to this contract. The payoff is the remaining principal as of the date above; payments made after that date reduce it one-for-one.
          Vehicle ownership is transferred once the payoff is received{"\n"}and any other balances with TransRev are settled.
        </Text>
      </Page>
    </Document>,
  );
}
