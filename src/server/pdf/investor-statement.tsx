import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings } from "@/db/schema";
import { endOfMonth, type IsoDate } from "@/lib/dates";
import { formatPeso, ZERO } from "@/lib/money";

// The PDF's built-in fonts have no ₱ sign.
const php = (v: bigint) => (v < ZERO ? `-PHP ${formatPeso(-v, { symbol: false })}` : `PHP ${formatPeso(v, { symbol: false })}`);

const s = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 4 },
  muted: { color: "#666" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#ddd", paddingVertical: 3 },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  total: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#333", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  cVeh: { width: 70 }, cDrv: { flex: 1 }, cNum: { width: 78, textAlign: "right" }, cSt: { width: 80, textAlign: "right" },
  box: { borderWidth: 0.5, borderColor: "#999", padding: 6, flex: 1 },
});

export type InvestorStatementLine = {
  investor_id: string;
  investor: string;
  month: string;
  plate_no: string;
  driver: string | null;
  daily_rate: string;
  boundary_days: number;
  amortization: string;
  computed: string;
  payable: string;
  status: string;
  paid_on: string | null;
  reference: string | null;
};

/** Investor payout rows (the statement is exactly these rows). RLS: finance/owner, or the investor's own. */
export async function investorStatementLines(tx: Tx, input: { investorId?: string | null; from: IsoDate; to: IsoDate }): Promise<InvestorStatementLine[]> {
  return tx.execute<InvestorStatementLine>(sql`
    SELECT p.investor_id, i.name AS investor, p.month::text, v.plate_no,
      -- Investors can't read driver records (RLS): they see "Assigned driver" instead of a name.
      CASE WHEN p.driver_id IS NULL THEN NULL
        ELSE COALESCE((SELECT d.first_name || ' ' || d.last_name FROM public.drivers d WHERE d.id = p.driver_id), 'Assigned driver') END AS driver,
      p.daily_rate_centavos::text AS daily_rate, p.boundary_days, p.monthly_amortization_centavos::text AS amortization,
      p.computed_centavos::text AS computed, p.payable_centavos::text AS payable, p.status::text, p.paid_on::text, p.reference
    FROM public.investor_payouts p JOIN public.investors i ON i.id = p.investor_id JOIN public.vehicles v ON v.id = p.vehicle_id
    WHERE p.month BETWEEN date_trunc('month', ${input.from}::date)::date AND ${input.to}::date
      AND ${input.investorId ? sql`p.investor_id = ${input.investorId}::uuid` : sql`true`}
    ORDER BY i.name, p.month, v.plate_no`);
}

/**
 * Monthly investor statement (owner model, docs §12–13): per vehicle,
 * 22 × the driver's daily boundary − the driver's monthly RTO amortization;
 * a negative month is paid as PHP 0.00 and flagged. No deductions or fees.
 * One section per investor and month. Returns null when there is nothing to show.
 */
export async function renderInvestorStatementPdf(tx: Tx, input: { investorId?: string | null; from: IsoDate; to: IsoDate }): Promise<Buffer | null> {
  const lines = await investorStatementLines(tx, input);
  if (lines.length === 0) return null;
  const [company] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
  const companyName = (company?.value as { name?: string } | undefined)?.name ?? "TransRev";
  const groups = new Map<string, InvestorStatementLine[]>();
  for (const l of lines) groups.set(`${l.investor_id}|${l.month}`, [...(groups.get(`${l.investor_id}|${l.month}`) ?? []), l]);

  const doc = (
    <Document title="Investor statement">
      {[...groups.values()].map((g) => {
        const first = g[0];
        const payable = g.reduce((t, l) => t + BigInt(l.payable), ZERO);
        const paid = g.filter((l) => l.status === "paid").reduce((t, l) => t + BigInt(l.payable), ZERO);
        const flagged = g.filter((l) => BigInt(l.computed) < ZERO);
        return (
          <Page key={`${first.investor_id}-${first.month}`} size="A4" orientation="landscape" style={s.page}>
            <Text style={s.h1}>{companyName}</Text>
            <Text style={{ fontSize: 11, marginTop: 4 }}>Investor statement · {first.month.slice(0, 7)}</Text>
            <Text style={s.muted}>{first.investor} · period {first.month} to {endOfMonth(first.month as IsoDate)}</Text>
            <View style={{ flexDirection: "row", gap: 12, marginTop: 10 }}>
              <View style={s.box}><Text style={s.muted}>Share for the month</Text><Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{php(payable)}</Text></View>
              <View style={s.box}><Text style={s.muted}>Paid</Text><Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{php(paid)}</Text></View>
              <View style={s.box}><Text style={s.muted}>Still to be paid</Text><Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{php(payable - paid)}</Text></View>
            </View>
            <Text style={s.h2}>Per vehicle</Text>
            <View style={s.head}>
              <Text style={s.cVeh}>Vehicle</Text>
              <Text style={s.cDrv}>Driver</Text>
              <Text style={s.cNum}>Daily boundary</Text>
              <Text style={s.cNum}>x days</Text>
              <Text style={s.cNum}>Less RTO amort.</Text>
              <Text style={s.cNum}>Share</Text>
              <Text style={s.cSt}>Status</Text>
            </View>
            {g.map((l) => (
              <View key={l.plate_no} style={s.row} wrap={false}>
                <Text style={s.cVeh}>{l.plate_no}</Text>
                <Text style={s.cDrv}>{l.driver ?? "no driver"}</Text>
                <Text style={s.cNum}>{php(BigInt(l.daily_rate))}</Text>
                <Text style={s.cNum}>{php(BigInt(l.daily_rate) * BigInt(l.boundary_days))} ({l.boundary_days})</Text>
                <Text style={s.cNum}>{php(BigInt(l.amortization))}</Text>
                <Text style={s.cNum}>{php(BigInt(l.payable))}{BigInt(l.computed) < ZERO ? " *" : ""}</Text>
                <Text style={s.cSt}>{l.status === "paid" ? `paid ${l.paid_on ?? ""}` : "pending"}</Text>
              </View>
            ))}
            <View style={s.total}>
              <Text style={s.cVeh}>Total</Text>
              <Text style={s.cDrv} />
              <Text style={s.cNum} />
              <Text style={s.cNum} />
              <Text style={s.cNum} />
              <Text style={s.cNum}>{php(payable)}</Text>
              <Text style={s.cSt} />
            </View>
            {flagged.length ? (
              <Text style={[s.muted, { marginTop: 8 }]}>
                * The formula gave a negative amount ({flagged.map((l) => `${l.plate_no}: ${php(BigInt(l.computed))}`).join("; ")}); it is paid as PHP 0.00 and flagged for review.
              </Text>
            ) : null}
            <Text style={[s.muted, { marginTop: 12 }]}>
              Share per vehicle = {first.boundary_days} x the driver&apos;s daily boundary rate − the driver&apos;s monthly RTO amortization. No percentage split, deductions or fees.
            </Text>
          </Page>
        );
      })}
    </Document>
  );
  return renderToBuffer(doc);
}
