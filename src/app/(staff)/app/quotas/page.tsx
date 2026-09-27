import { asc, sql } from "drizzle-orm";
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
import { quotaRules } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { addDays, addMonths, businessToday, isIsoDate, type IsoDate } from "@/lib/dates";
import { formatPeso, toDecimalString } from "@/lib/money";
import { METRIC_LABEL, periodFor, type QuotaMetric, type QuotaPeriod } from "@/lib/quotas";
import { awardBonusAction, importCsvAction, saveResultsAction, saveRuleAction, voidBonusAction } from "./actions";
import { CsvImport } from "./csv-import";

export const metadata = { title: "Quotas & bonuses" };

type Row = {
  driver_id: string; name: string; plate_no: string | null; result_id: string | null; value: string | null;
  award_id: string | null; award_mode: string | null; award_amount: string | null; award_voided: boolean | null;
};

export default async function QuotasPage({ searchParams }: PageProps<"/app/quotas">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const canManage = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const sp = await searchParams;
  const today = businessToday();
  const rules = await withUserTx(session.claims, (tx) => tx.select().from(quotaRules).orderBy(asc(quotaRules.name)));
  const rule = rules.find((r) => r.id === sp.rule) ?? rules.find((r) => r.active) ?? rules[0];
  const anchor = (typeof sp.date === "string" && isIsoDate(sp.date) ? sp.date : today) as IsoDate;
  const period = rule ? periodFor(rule.period as QuotaPeriod, anchor) : null;
  const metric = (rule?.metric ?? "trips") as QuotaMetric;
  const fmtValue = (v: bigint) => (metric === "earnings_centavos" ? formatPeso(v) : v.toString());
  const inputValue = (v: bigint) => (metric === "earnings_centavos" ? toDecimalString(v) : v.toString());

  const rows =
    rule && period
      ? await withUserTx(session.claims, (tx) =>
          tx.execute<Row>(sql`
            SELECT d.id AS driver_id, d.last_name || ', ' || d.first_name AS name, v.plate_no,
              r.id AS result_id, r.value::text AS value,
              b.id AS award_id, b.payout_mode AS award_mode, b.amount_centavos::text AS award_amount, (b.voided_at IS NOT NULL) AS award_voided
            FROM public.drivers d
            LEFT JOIN public.vehicle_assignments va ON va.driver_id = d.id AND va.end_date IS NULL
            LEFT JOIN public.vehicles v ON v.id = va.vehicle_id
            LEFT JOIN public.quota_results r ON r.driver_id = d.id AND r.rule_id = ${rule.id}::uuid AND r.period_start = ${period.start}::date
            LEFT JOIN LATERAL (SELECT * FROM public.bonus_awards ba WHERE ba.quota_result_id = r.id ORDER BY ba.voided_at NULLS FIRST LIMIT 1) b ON true
            WHERE d.status IN ('active', 'suspended') OR r.id IS NOT NULL
            ORDER BY d.last_name, d.first_name`),
        )
      : [];
  const hits = rule ? rows.filter((r) => r.value !== null && BigInt(r.value) >= rule.threshold).length : 0;
  const periodLink = (d: IsoDate) => `/app/quotas?rule=${rule?.id}&date=${d}`;

  return (
    <>
      <PageHeader title="Quotas & bonuses" description="Record ride counts per driver, see who hit the quota, and award bonuses in cash or as a balance credit." />

      {rules.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {rules.map((r) => (
            <Button key={r.id} asChild size="sm" variant={r.id === rule?.id ? "default" : "outline"}>
              <Link href={`/app/quotas?rule=${r.id}`}>{r.name}</Link>
            </Button>
          ))}
        </div>
      ) : null}

      {rule && period ? (
        <>
          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{rule.name}</CardTitle>
                <Badge variant={rule.active ? "success" : "muted"}>{rule.active ? "active" : "inactive"}</Badge>
              </div>
              <CardDescription>
                {fmtValue(rule.threshold)} {METRIC_LABEL[metric]} per {rule.period === "monthly" ? "month" : "week"} → bonus{" "}
                {formatPeso(rule.bonusCentavos)}
                {!rule.active ? " · Set the bonus amount and activate before awarding." : ""}
              </CardDescription>
            </CardHeader>
            {canManage ? (
              <CardContent>
                <details>
                  <summary className="cursor-pointer text-sm">Edit rule</summary>
                  <RuleForm rule={rule} />
                </details>
              </CardContent>
            ) : null}
          </Card>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Link href={periodLink(rule.period === "monthly" ? addMonths(period.start, -1) : addDays(period.start, -7))} className="rounded border px-2 py-1" aria-label="Previous period">
                ‹
              </Link>
              <span className="font-medium">
                {period.start} – {period.end}
              </span>
              <Link href={periodLink(rule.period === "monthly" ? addMonths(period.start, 1) : addDays(period.start, 7))} className="rounded border px-2 py-1" aria-label="Next period">
                ›
              </Link>
            </div>
            <Badge variant="success">{hits} hit(s)</Badge>
          </div>

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <ActionForm action={saveResultsAction} className="flex flex-col">
                <input type="hidden" name="ruleId" value={rule.id} />
                <input type="hidden" name="periodDate" value={period.start} />
                <Table>
                  <thead>
                    <tr>
                      <Th>Driver</Th>
                      <Th className="w-36">{METRIC_LABEL[metric]}</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const value = r.value === null ? null : BigInt(r.value);
                      const hit = value !== null && value >= rule.threshold;
                      const locked = Boolean(r.award_id && !r.award_voided);
                      return (
                        <tr key={r.driver_id}>
                          <Td>
                            <Link href={`/app/drivers/${r.driver_id}`} className="font-medium underline-offset-2 hover:underline">
                              {r.name}
                            </Link>
                            <div className="text-xs text-muted-foreground">{r.plate_no ?? ""}</div>
                          </Td>
                          <Td>
                            <input type="hidden" name={`orig:${r.driver_id}`} value={value === null ? "" : value.toString()} />
                            <Input
                              name={`value:${r.driver_id}`}
                              inputMode={metric === "earnings_centavos" ? "decimal" : "numeric"}
                              defaultValue={value === null ? "" : inputValue(value)}
                              disabled={locked}
                              aria-label={`${r.name} ${METRIC_LABEL[metric]}`}
                            />
                          </Td>
                          <Td>
                            {value === null ? (
                              <span className="text-xs text-muted-foreground">not recorded</span>
                            ) : hit ? (
                              <Badge variant="success">hit</Badge>
                            ) : (
                              <Badge variant="muted">{fmtValue(rule.threshold - value)} short</Badge>
                            )}
                            {r.award_id ? (
                              <div className="mt-1 text-xs">
                                {r.award_voided ? (
                                  <Badge variant="destructive">bonus void</Badge>
                                ) : (
                                  <>
                                    <Money value={r.award_amount} /> {r.award_mode === "credit" ? "credited" : "paid in cash"}
                                  </>
                                )}
                              </div>
                            ) : null}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
                <div className="p-4">
                  <Button type="submit">Save counts</Button>
                </div>
              </ActionForm>
            </Card>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Import CSV</CardTitle>
                </CardHeader>
                <CardContent>
                  <CsvImport action={importCsvAction} ruleId={rule.id} periodDate={period.start} />
                </CardContent>
              </Card>

              {canManage ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Award bonuses</CardTitle>
                    <CardDescription>Owner rule: pay in cash or credit the driver&apos;s boundary balance.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {rows.filter((r) => r.value !== null && BigInt(r.value) >= rule.threshold && !(r.award_id && !r.award_voided)).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No unawarded hits for this period.</p>
                    ) : null}
                    {rows
                      .filter((r) => r.value !== null && BigInt(r.value) >= rule.threshold)
                      .map((r) =>
                        r.award_id && !r.award_voided ? (
                          <details key={r.driver_id} className="text-sm">
                            <summary className="cursor-pointer">
                              {r.name}: <Money value={r.award_amount} /> {r.award_mode === "credit" ? "credited" : "cash"}
                            </summary>
                            <ActionForm action={voidBonusAction} className="mt-2 flex gap-2">
                              <input type="hidden" name="awardId" value={r.award_id} />
                              <Input name="reason" placeholder="Reason" required className="h-8" />
                              <Button type="submit" size="sm" variant="destructive">
                                Void
                              </Button>
                            </ActionForm>
                          </details>
                        ) : r.award_id ? null : (
                          <ActionForm key={r.driver_id} action={awardBonusAction} className="flex flex-wrap items-center gap-2 text-sm">
                            <input type="hidden" name="quotaResultId" value={r.result_id!} />
                            <span className="flex-1 font-medium">{r.name}</span>
                            <Select name="mode" className="h-8 w-28" aria-label={`Payout for ${r.name}`}>
                              <option value="credit">Credit</option>
                              <option value="cash">Cash</option>
                            </Select>
                            <Button type="submit" size="sm" disabled={!rule.active}>
                              Award {formatPeso(rule.bonusCentavos)}
                            </Button>
                          </ActionForm>
                        ),
                      )}
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No quota rules yet.</p>
      )}

      {canManage ? (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm font-medium">Add another quota rule</summary>
          <Card className="mt-3">
            <CardContent className="pt-4">
              <RuleForm />
            </CardContent>
          </Card>
        </details>
      ) : null}
    </>
  );
}

function RuleForm({ rule }: { rule?: typeof quotaRules.$inferSelect }) {
  const metric = (rule?.metric ?? "trips") as QuotaMetric;
  return (
    <ActionForm action={saveRuleAction} className="mt-3 grid gap-3 sm:grid-cols-3">
      {rule ? <input type="hidden" name="id" value={rule.id} /> : null}
      <Field label="Name" htmlFor={`name-${rule?.id ?? "new"}`}>
        <Input id={`name-${rule?.id ?? "new"}`} name="name" defaultValue={rule?.name} required />
      </Field>
      <Field label="Measure" htmlFor={`metric-${rule?.id ?? "new"}`}>
        <Select id={`metric-${rule?.id ?? "new"}`} name="metric" defaultValue={metric}>
          <option value="trips">Rides / trips</option>
          <option value="earnings_centavos">Earnings (₱)</option>
        </Select>
      </Field>
      <Field label="Period" htmlFor={`period-${rule?.id ?? "new"}`}>
        <Select id={`period-${rule?.id ?? "new"}`} name="period" defaultValue={rule?.period ?? "monthly"}>
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly (Mon–Sun)</option>
        </Select>
      </Field>
      <Field label="Target" htmlFor={`threshold-${rule?.id ?? "new"}`}>
        <Input
          id={`threshold-${rule?.id ?? "new"}`}
          name="threshold"
          inputMode="decimal"
          defaultValue={rule ? (metric === "earnings_centavos" ? toDecimalString(rule.threshold) : rule.threshold.toString()) : "200"}
          required
        />
      </Field>
      <Field label="Bonus amount" htmlFor={`bonus-${rule?.id ?? "new"}`}>
        <Input id={`bonus-${rule?.id ?? "new"}`} name="bonus" inputMode="decimal" defaultValue={rule && rule.bonusCentavos > BigInt(0) ? toDecimalString(rule.bonusCentavos) : ""} />
      </Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={rule?.active} className="size-4" /> Active
      </label>
      <Button type="submit" className="justify-self-start">
        Save rule
      </Button>
    </ActionForm>
  );
}
