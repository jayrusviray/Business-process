import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import {
  CASH_IN_CATEGORIES,
  CASH_OUT_CATEGORIES,
  categoryLabel,
  collapseDriverPayments,
  MANUAL_CATEGORIES,
  reconciliationVariance,
  summarizeFlows,
  UNASSIGNED,
  withRunningBalances,
} from "@/lib/cashbook";
import { addDays, businessToday, isIsoDate, startOfMonth, type IsoDate } from "@/lib/dates";
import { ZERO } from "@/lib/money";
import {
  cashBalancesAtMany,
  cashBookRows,
  latestReconciliations,
  listCashAccounts,
  reconciliationsBetween,
  unremittedCash,
} from "@/server/queries/cashbook";
import { reassignAction, reconcileAction, recordCashEntryAction, transferAction, voidCashEntryAction } from "./actions";

export const metadata = { title: "Cash book" };

const PAGE_SIZE = 200;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Cash book (spec 4.15): every inflow and outflow per money account, with running balances and reconciliations. */
export default async function CashBookPage({ searchParams }: PageProps<"/app/cashbook">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const sp = await searchParams;
  const today = businessToday();
  const qFrom = str(sp.from);
  const qTo = str(sp.to);
  let from = (isIsoDate(qFrom) ? qFrom : startOfMonth(today)) as IsoDate;
  let to = (isIsoDate(qTo) ? qTo : today) as IsoDate;
  if (to < from) [from, to] = [to, from];
  const accountId = /^[0-9a-f-]{36}$/i.test(str(sp.account)) ? str(sp.account) : "";
  const category = str(sp.category);
  const direction = str(sp.direction) === "in" || str(sp.direction) === "out" ? (str(sp.direction) as "in" | "out") : "";
  const detail = str(sp.detail) === "1";
  const page = Math.max(1, Number.parseInt(str(sp.page) || "1", 10) || 1);

  const data = await withUserTx(session.claims, async (tx) => {
    const [accounts, [before, now], rows, recs, latest, unremitted] = [
      await listCashAccounts(tx),
      await cashBalancesAtMany(tx, [addDays(from, -1), today]),
      await cashBookRows(tx, { from, to, accountId: accountId || null }),
      await reconciliationsBetween(tx, from, to),
      await latestReconciliations(tx),
      await unremittedCash(tx),
    ];
    return { accounts, before, now, rows, recs, latest, unremitted };
  });

  const name = new Map(data.accounts.map((a) => [a.id, a.name]));
  const accountName = (id: string | null) => (id ? (name.get(id) ?? "Unknown") : "Unassigned");
  // Running balances are computed over every row of the account(s), then the filters narrow what is shown.
  const { rows: withBal } = withRunningBalances(data.before, data.rows);
  const filtered = withBal.filter((r) => (!category || r.category === category) && (!direction || r.direction === direction));
  const shown = (detail ? filtered.map((r) => ({ ...r, count: 1 })) : collapseDriverPayments(filtered)).reverse();
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const pageRows = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const flows = summarizeFlows(filtered);
  const opening = accountId ? (data.before.get(accountId) ?? ZERO) : [...data.before.values()].reduce((s, v) => s + v, ZERO);
  const closing = opening + withBal.reduce((s, r) => s + (r.direction === "in" ? r.amount : -r.amount), ZERO);
  const activeAccounts = data.accounts.filter((a) => a.active);
  const cashAccountId = data.accounts.find((a) => a.paymentMethod === "cash")?.id;
  const unassigned = data.now.get(UNASSIGNED);

  const qs = (over: Record<string, string>) => {
    const p = new URLSearchParams({ from, to, ...(accountId ? { account: accountId } : {}), ...(category ? { category } : {}), ...(direction ? { direction } : {}), ...(detail ? { detail: "1" } : {}), ...over });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/app/cashbook?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Cash book"
        description="Every peso in and out, per account. Balances are computed from the records; voided records never count."
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button asChild variant="outline"><Link href="/app/cashbook/accounts">Accounts &amp; routing</Link></Button>
            <Button asChild variant="outline"><Link href={`/app/reports/cash-flow?from=${from}&to=${to}`}>Cash flow report</Link></Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.accounts.filter((a) => a.active || (data.now.get(a.id) ?? ZERO) !== ZERO).map((a) => {
          const rec = data.latest.find((l) => l.account_id === a.id);
          const changed = rec && rec.live !== rec.system;
          return (
            <Card key={a.id}>
              <CardHeader>
                <CardDescription className="flex items-center justify-between gap-2">
                  <span>{a.name}</span>
                  {a.paymentMethod ? <Badge variant="muted">{a.paymentMethod.replace("_", " ")}</Badge> : null}
                </CardDescription>
                <CardTitle className="text-xl"><Money value={data.now.get(a.id) ?? ZERO} /></CardTitle>
                {a.id === cashAccountId && data.unremitted > ZERO ? (
                  <p className="text-xs text-muted-foreground">of which <Money value={data.unremitted} /> is still with collectors (not yet remitted)</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {rec ? (
                    <>
                      Last counted {rec.as_of_date}:{" "}
                      {reconciliationVariance(BigInt(rec.counted), BigInt(rec.system)) === ZERO ? (
                        <Badge variant="success">matched</Badge>
                      ) : (
                        <Badge variant="destructive">off by <Money value={reconciliationVariance(BigInt(rec.counted), BigInt(rec.system))} /></Badge>
                      )}
                      {changed ? <span className="block text-destructive">Records dated on or before {rec.as_of_date} changed since that count (books now <Money value={rec.live} />).</span> : null}
                    </>
                  ) : (
                    "Not reconciled yet"
                  )}
                </p>
              </CardHeader>
            </Card>
          );
        })}
        {unassigned && unassigned !== ZERO ? (
          <Card className="border-warning">
            <CardHeader>
              <CardDescription>Unassigned (no &ldquo;Other&rdquo; account)</CardDescription>
              <CardTitle className="text-xl"><Money value={unassigned} /></CardTitle>
            </CardHeader>
          </Card>
        ) : null}
      </div>

      <form className="mb-4 grid gap-2 rounded-md border p-3 sm:grid-cols-3 lg:grid-cols-6 print:hidden">
        <Field label="From" htmlFor="from"><Input id="from" name="from" type="date" defaultValue={from} /></Field>
        <Field label="To" htmlFor="to"><Input id="to" name="to" type="date" defaultValue={to} /></Field>
        <Field label="Account" htmlFor="account">
          <Select id="account" name="account" defaultValue={accountId}>
            <option value="">All accounts</option>
            {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Category" htmlFor="category">
          <Select id="category" name="category" defaultValue={category}>
            <option value="">All</option>
            <optgroup label="Money in">{CASH_IN_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</optgroup>
            <optgroup label="Money out">{CASH_OUT_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</optgroup>
          </Select>
        </Field>
        <Field label="In / out" htmlFor="direction">
          <Select id="direction" name="direction" defaultValue={direction}>
            <option value="">Both</option><option value="in">Money in</option><option value="out">Money out</option>
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="detail" value="1" defaultChecked={detail} className="size-4" /> Each driver payment</label>
          <Button type="submit" variant="outline">Show</Button>
        </div>
      </form>

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Card><CardHeader><CardDescription>Opening balance {from}</CardDescription><CardTitle><Money value={opening} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Money in</CardDescription><CardTitle><Money value={flows.totalIn} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Money out</CardDescription><CardTitle><Money value={flows.totalOut} /></CardTitle></CardHeader></Card>
        <Card>
          <CardHeader>
            <CardDescription>Closing balance {to}</CardDescription>
            <CardTitle><Money value={closing} /></CardTitle>
            <p className="text-xs text-muted-foreground">Net flow <Money value={flows.net} signed={false} />{flows.transfersIn > ZERO || flows.openingBalances > ZERO ? "; transfers and opening balances are not counted as in/out" : ""}</p>
          </CardHeader>
        </Card>
      </div>

      <Card className="mb-6">
        <Table>
          <thead>
            <tr>
              <Th>Date</Th><Th>Account</Th><Th>Category</Th><Th>Details</Th>
              <Th className="text-right">In</Th><Th className="text-right">Out</Th><Th className="text-right">Balance</Th><Th className="print:hidden" />
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? <tr><Td colSpan={8} className="text-muted-foreground">Nothing in this period.</Td></tr> : null}
            {pageRows.map((r) => {
              const recsHere = data.recs.filter((x) => x.as_of_date === r.entryDate && (!accountId || x.account_id === accountId));
              const firstOfDay = pageRows.find((x) => x.entryDate === r.entryDate) === r;
              return [
                firstOfDay
                  ? recsHere.map((x) => (
                      <tr key={`rec-${x.id}`} className="bg-success/10">
                        <Td>{x.as_of_date}</Td>
                        <Td>{accountName(x.account_id)}</Td>
                        <Td colSpan={6}>
                          Reconciled: counted <Money value={x.counted} />, books <Money value={x.system} />
                          {reconciliationVariance(BigInt(x.counted), BigInt(x.system)) !== ZERO ? <> · difference <Money value={reconciliationVariance(BigInt(x.counted), BigInt(x.system))} /></> : " · matched"}
                          <span className="text-xs text-muted-foreground"> · {x.by ?? ""}{x.notes ? ` · ${x.notes}` : ""}</span>
                        </Td>
                      </tr>
                    ))
                  : null,
                <tr key={`${r.sourceType}:${r.sourceId}:${r.lineKey}:${r.entryDate}:${r.category}`}>
                  <Td className="whitespace-nowrap">{r.entryDate}</Td>
                  <Td>{accountName(r.accountId)}{r.reassigned ? <Badge variant="muted" className="ml-1">moved</Badge> : null}</Td>
                  <Td>{categoryLabel(r.category)}{r.subcategory ? <div className="text-xs text-muted-foreground">{r.subcategory}</div> : null}</Td>
                  <Td>
                    {r.count > 1 ? (
                      <>{r.count} driver payments</>
                    ) : (
                      <>
                        {r.counterparty ? <span className="font-medium">{r.counterparty}</span> : null} {r.description}
                        {r.reference ? <span className="text-xs text-muted-foreground"> · {r.reference}</span> : null}
                      </>
                    )}
                  </Td>
                  <Td className="text-right">{r.direction === "in" ? <Money value={r.amount} /> : null}</Td>
                  <Td className="text-right">{r.direction === "out" ? <Money value={r.amount} /> : null}</Td>
                  <Td className="text-right"><Money value={r.balanceAfter} /></Td>
                  <Td className="print:hidden">
                    {r.sourceType === "cash_transaction" && r.lineKey !== "in" ? (
                      <details>
                        <summary className="cursor-pointer text-xs underline">Void</summary>
                        <ActionForm action={voidCashEntryAction} className="mt-1 flex flex-col gap-1">
                          <input type="hidden" name="id" value={r.sourceId} />
                          <Input name="reason" placeholder="Reason" aria-label="Reason" className="h-8" required />
                          <Button type="submit" size="sm" variant="destructive">Void entry</Button>
                        </ActionForm>
                      </details>
                    ) : r.sourceType !== "cash_transaction" && r.count === 1 ? (
                      <details>
                        <summary className="cursor-pointer text-xs underline">Move</summary>
                        <ActionForm action={reassignAction} className="mt-1 flex flex-col gap-1">
                          <input type="hidden" name="sourceType" value={r.sourceType} />
                          <input type="hidden" name="sourceId" value={r.sourceId} />
                          <Select name="accountId" aria-label="Move to account" className="h-8">
                            {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </Select>
                          <Input name="reason" placeholder="Why (e.g. paid from GCash)" aria-label="Reason" className="h-8" required />
                          <Button type="submit" size="sm" variant="outline">Move</Button>
                        </ActionForm>
                      </details>
                    ) : null}
                  </Td>
                </tr>,
              ];
            })}
          </tbody>
        </Table>
        {pages > 1 ? (
          <div className="flex items-center justify-between gap-2 p-3 text-sm print:hidden">
            <span className="text-muted-foreground">Page {page} of {pages} · newest first</span>
            <span className="flex gap-2">
              {page > 1 ? <Link className="underline" href={qs({ page: String(page - 1) })}>Newer</Link> : null}
              {page < pages ? <Link className="underline" href={qs({ page: String(page + 1) })}>Older</Link> : null}
            </span>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3 print:hidden">
        <Card>
          <CardHeader><CardTitle>Record money in or out</CardTitle><CardDescription>For what no module records: platform revenue, capital, owner withdrawals, opening balances…</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={recordCashEntryAction} className="grid gap-3">
              <Field label="Category" htmlFor="c-category">
                <Select id="c-category" name="category" required>
                  {MANUAL_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label} ({c.direction})</option>)}
                </Select>
              </Field>
              <Field label="Account" htmlFor="c-account">
                <Select id="c-account" name="accountId" required>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
              </Field>
              <Field label="Amount" htmlFor="c-amount"><Input id="c-amount" name="amount" inputMode="decimal" required /></Field>
              <Field label="Date" htmlFor="c-date"><Input id="c-date" name="entryDate" type="date" max={today} defaultValue={today} required /></Field>
              <Field label="Description" htmlFor="c-desc"><Input id="c-desc" name="description" required /></Field>
              <Field label="From / to (optional)" htmlFor="c-cp"><Input id="c-cp" name="counterparty" /></Field>
              <Field label="Reference (optional)" htmlFor="c-ref"><Input id="c-ref" name="reference" /></Field>
              <Button type="submit">Record</Button>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Transfer between accounts</CardTitle><CardDescription>E.g. depositing cash on hand to the bank. Shown as two lines; the total doesn&apos;t change.</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={transferAction} className="grid gap-3">
              <Field label="From" htmlFor="t-from">
                <Select id="t-from" name="fromAccountId" required>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
              </Field>
              <Field label="To" htmlFor="t-to">
                <Select id="t-to" name="toAccountId" required defaultValue={activeAccounts[1]?.id}>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
              </Field>
              <Field label="Amount" htmlFor="t-amount"><Input id="t-amount" name="amount" inputMode="decimal" required /></Field>
              <Field label="Date" htmlFor="t-date"><Input id="t-date" name="entryDate" type="date" max={today} defaultValue={today} required /></Field>
              <Field label="Note (optional)" htmlFor="t-desc"><Input id="t-desc" name="description" /></Field>
              <Field label="Reference (optional)" htmlFor="t-ref"><Input id="t-ref" name="reference" /></Field>
              <Button type="submit">Record transfer</Button>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Reconcile an account</CardTitle><CardDescription>Count the cash (or read the GCash/bank balance) at the end of a day, usually month-end. The books&apos; balance for that day is saved with your count.</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={reconcileAction} className="grid gap-3">
              <Field label="Account" htmlFor="r-account">
                <Select id="r-account" name="accountId" required>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
              </Field>
              <Field label="As of (end of day)" htmlFor="r-date"><Input id="r-date" name="asOfDate" type="date" max={today} defaultValue={today} required /></Field>
              <Field label="Counted / statement balance" htmlFor="r-counted" hint="Cash on hand: the books include cash collectors haven't remitted yet (see its card). Add it to your count, or explain the difference in the notes.">
                <Input id="r-counted" name="counted" inputMode="decimal" required />
              </Field>
              <Field label="Notes" htmlFor="r-notes"><Input id="r-notes" name="notes" /></Field>
              <Button type="submit">Save count</Button>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
