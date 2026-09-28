import { Money } from "@/components/money";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx, type JwtClaims } from "@/db/client";
import { listLegacyPayments } from "@/server/imports/service";

const ACCOUNT = { boundary: "Boundary", amortization: "Amortization", charges: "Costs & deposit" } as const;

/** Payments from the old spreadsheets (imported for reference; they never change balances). */
export async function LegacyPaymentsCard({ claims, driverId }: { claims: JwtClaims; driverId: string }) {
  const rows = await withUserTx(claims, (tx) => listLegacyPayments(tx, driverId));
  if (rows.length === 0) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Payments before go-live</CardTitle>
        <CardDescription>
          From the old spreadsheets, for reference only. They are not in the statements above and do not change any balance: what the
          driver still owed at go-live is the opening balance.
        </CardDescription>
      </CardHeader>
      <Table>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Method</Th>
            <Th>For</Th>
            <Th className="text-right">Amount</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <Td className="whitespace-nowrap">{p.paidOn}</Td>
              <Td>
                {p.method.replace("_", " ")}
                {p.referenceNo ? <div className="text-xs text-muted-foreground">{p.referenceNo}</div> : null}
              </Td>
              <Td>
                {p.account ? ACCOUNT[p.account] : "—"}
                {p.notes ? <div className="text-xs text-muted-foreground">{p.notes}</div> : null}
              </Td>
              <Td className="text-right">
                <Money value={p.amountCentavos} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
