import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, employees, payrollLines, payrollPeriods } from "@/db/schema";
import { formatPeso } from "@/lib/money";
import { breakdownOf } from "@/server/office/payroll";

const php = (v: bigint) => `PHP ${formatPeso(v, { symbol: false })}`;
const s = StyleSheet.create({
  page: { padding: 36, fontSize: 9.5, fontFamily: "Helvetica" },
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  cols: { flexDirection: "row", gap: 24, marginTop: 14 },
  col: { flex: 1 },
  h2: { fontFamily: "Helvetica-Bold", marginBottom: 4, borderBottomWidth: 1, paddingBottom: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderTopWidth: 0.5, fontFamily: "Helvetica-Bold" },
  net: { flexDirection: "row", justifyContent: "space-between", marginTop: 16, padding: 8, borderWidth: 1, fontSize: 12, fontFamily: "Helvetica-Bold" },
  muted: { color: "#666" },
});

/** Payslip for one payroll line (RLS applies: finance/admin, or the employee for their own finalized slip). */
export async function renderPayslipPdf(tx: Tx, lineId: string): Promise<Buffer | null> {
  const [row] = await tx
    .select({ l: payrollLines, p: payrollPeriods, e: employees })
    .from(payrollLines)
    .innerJoin(payrollPeriods, eq(payrollPeriods.id, payrollLines.periodId))
    .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
    .where(eq(payrollLines.id, lineId));
  if (!row) return null;
  const { l, p, e } = row;
  const b = breakdownOf(l);
  const [company] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
  const name = (company?.value as { name?: string } | undefined)?.name ?? "TransRev";
  const line = (label: string, v: bigint | undefined) =>
    v && v !== BigInt(0) ? (
      <View style={s.row} key={label}>
        <Text>{label}</Text>
        <Text>{php(v)}</Text>
      </View>
    ) : null;
  const deductions = b.sssEmployee + b.philhealthEmployee + b.pagibigEmployee + b.withholdingTax + b.otherDeductions + b.cashAdvanceDeduction;
  return renderToBuffer(
    <Document title={`Payslip ${e.lastName} ${p.periodStart}`}>
      <Page size="A5" orientation="landscape" style={s.page}>
        <Text style={s.h1}>{name}: Payslip{p.status === "draft" ? " (DRAFT)" : ""}</Text>
        <Text style={s.muted}>
          {e.lastName}, {e.firstName} · {e.employeeNo} · {e.position} · Period {p.periodStart} to {p.periodEnd} · Pay date {p.payDate}
        </Text>
        <View style={s.cols}>
          <View style={s.col}>
            <Text style={s.h2}>Earnings</Text>
            {line("Basic pay", b.basicPay)}
            {line("Less absences", b.absenceDeduction ? -b.absenceDeduction : undefined)}
            {line("Less lates", b.lateDeduction ? -b.lateDeduction : undefined)}
            {line("Holiday pay", b.holidayPay)}
            {line("Overtime", b.overtimePay)}
            {line("Rest day / holiday premium", b.premiumPay)}
            {line("Night differential", b.nightDiffPay)}
            {line("Allowance", b.allowance)}
            {line("Other earnings", b.otherTaxableEarnings)}
            {line("Reimbursements (non-taxable)", l.reimbursementsCentavos)}
            <View style={s.total}>
              <Text>Total earnings</Text>
              <Text>{php(b.grossTaxable + b.nonTaxable)}</Text>
            </View>
          </View>
          <View style={s.col}>
            <Text style={s.h2}>Deductions</Text>
            {line("SSS", b.sssEmployee)}
            {line("PhilHealth", b.philhealthEmployee)}
            {line("Pag-IBIG", b.pagibigEmployee)}
            {line("Withholding tax", b.withholdingTax)}
            {line("Cash advance", b.cashAdvanceDeduction)}
            {line("Other deductions", b.otherDeductions)}
            <View style={s.total}>
              <Text>Total deductions</Text>
              <Text>{php(deductions)}</Text>
            </View>
            <Text style={[s.muted, { marginTop: 8 }]}>
              Employer share: SSS {php(b.sssEmployer + b.sssEc)} · PhilHealth {php(b.philhealthEmployer)} · Pag-IBIG {php(b.pagibigEmployer)}
            </Text>
          </View>
        </View>
        <View style={s.net}>
          <Text>NET PAY</Text>
          <Text>{php(b.netPay)}</Text>
        </View>
        {l.notes ? <Text style={[s.muted, { marginTop: 6 }]}>Notes: {l.notes}</Text> : null}
      </Page>
    </Document>,
  );
}
