import { asc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { applicationCommissionRules, applicationStatuses, applicationTypes, checklistTemplates } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { SERVICE_LINE_LABELS, SERVICE_LINES } from "@/lib/crm";
import { toDecimalString } from "@/lib/money";
import { saveCommissionRuleAction, saveStatusAction, saveTemplateAction, saveTypeAction } from "../actions";

export const metadata = { title: "Application settings" };

const KIND_LABEL = {
  open: "In progress",
  approved: "Approved / activated (counts as approval)",
  completed: "Released / completed",
  on_hold: "On hold",
  cancelled: "Cancelled (needs a reason)",
} as const;

function pct(bps: number) {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac ? `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}` : String(whole);
}

/** Owner/admin: application types, the status pipeline, checklist templates and referral commission rules. */
export default async function ApplicationSettingsPage() {
  const session = await requireRole(["owner_admin"]);
  const data = await withUserTx(session.claims, async (tx) => ({
    types: await tx.select().from(applicationTypes).orderBy(asc(applicationTypes.sort)),
    statuses: await tx.select().from(applicationStatuses).orderBy(asc(applicationStatuses.sort)),
    templates: await tx.select().from(checklistTemplates).orderBy(asc(checklistTemplates.typeKey), asc(checklistTemplates.sort)),
    rules: await tx.select().from(applicationCommissionRules),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Application settings" description="Changes apply to new applications; existing checklists and fees stay as they are." />

      <Card>
        <CardHeader>
          <CardTitle>Application types</CardTitle>
          <CardDescription>The default fee is quoted when staff open an application (not on online applications).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {[...data.types.map((t) => ({ t, mode: "edit" as const })), { t: null, mode: "new" as const }].map(({ t, mode }) => (
            <ActionForm key={t?.key ?? "new"} action={saveTypeAction} className="grid gap-2 border-b pb-3 lg:grid-cols-[10rem_1fr_12rem_8rem_5rem_auto_auto_auto]">
              <input type="hidden" name="mode" value={mode} />
              {t ? (
                <>
                  <input type="hidden" name="key" value={t.key} />
                  <code className="self-center text-xs text-muted-foreground">{t.key}</code>
                </>
              ) : (
                <Input name="key" placeholder="key (e.g. ltfrb_cpc_dropping)" required aria-label="Key" />
              )}
              <Input name="label" defaultValue={t?.label} placeholder="Label" required aria-label="Label" />
              <Select name="serviceLine" defaultValue={t?.serviceLine ?? "franchise"} aria-label="Service line">
                {SERVICE_LINES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_LINE_LABELS[s]}
                  </option>
                ))}
              </Select>
              <Input name="defaultFee" inputMode="decimal" defaultValue={t && t.defaultFeeCentavos > BigInt(0) ? toDecimalString(t.defaultFeeCentavos) : ""} placeholder="Fee ₱" aria-label="Default fee" />
              <Input name="sort" type="number" defaultValue={t?.sort ?? 100} aria-label="Order" />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="publicForm" defaultChecked={t?.publicForm ?? true} className="size-4" /> Online
              </label>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="active" defaultChecked={t?.active ?? true} className="size-4" /> Active
              </label>
              <Button type="submit" variant="outline" size="sm">
                {mode === "new" ? "Add" : "Save"}
              </Button>
              <input type="hidden" name="description" value={t?.description ?? ""} />
            </ActionForm>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status pipeline</CardTitle>
          <CardDescription>Order and meaning of each status. Reports count approvals and completions by kind.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {[...data.statuses.map((s) => ({ s, mode: "edit" as const })), { s: null, mode: "new" as const }].map(({ s, mode }) => (
            <ActionForm key={s?.key ?? "new"} action={saveStatusAction} className="grid gap-2 border-b pb-3 sm:grid-cols-[10rem_1fr_16rem_5rem_auto_auto]">
              <input type="hidden" name="mode" value={mode} />
              {s ? (
                <>
                  <input type="hidden" name="key" value={s.key} />
                  <code className="self-center text-xs text-muted-foreground">{s.key}</code>
                </>
              ) : (
                <Input name="key" placeholder="key" required aria-label="Key" />
              )}
              <Input name="label" defaultValue={s?.label} placeholder="Label" required aria-label="Label" />
              <Select name="kind" defaultValue={s?.kind ?? "open"} aria-label="Kind">
                {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
              <Input name="sort" type="number" defaultValue={s?.sort ?? 55} aria-label="Order" />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="active" defaultChecked={s?.active ?? true} className="size-4" /> Active
              </label>
              <Button type="submit" variant="outline" size="sm">
                {mode === "new" ? "Add" : "Save"}
              </Button>
            </ActionForm>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Document checklists</CardTitle>
          <CardDescription>Copied into each new application of that type. The seeded lists are generic: replace them with the real requirements.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {data.types.map((t) => (
            <div key={t.key}>
              <p className="mb-2 text-sm font-semibold">{t.label}</p>
              <div className="flex flex-col gap-2">
                {[...data.templates.filter((x) => x.typeKey === t.key), null].map((tpl, i) => (
                  <ActionForm key={tpl?.id ?? `new-${i}`} action={saveTemplateAction} className="grid gap-2 sm:grid-cols-[1fr_auto_5rem_auto_auto]">
                    {tpl ? <input type="hidden" name="id" value={tpl.id} /> : null}
                    <input type="hidden" name="typeKey" value={t.key} />
                    <Input name="label" defaultValue={tpl?.label} placeholder="Add a document" required aria-label="Document" />
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="required" defaultChecked={tpl?.required ?? true} className="size-4" /> Required
                    </label>
                    <Input name="sort" type="number" defaultValue={tpl?.sort ?? 100} aria-label="Order" />
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="active" defaultChecked={tpl?.active ?? true} className="size-4" /> Active
                    </label>
                    <Button type="submit" variant="outline" size="sm">
                      {tpl ? "Save" : "Add"}
                    </Button>
                  </ActionForm>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Referral commissions per application type</CardTitle>
          <CardDescription>
            Paid to whoever referred an application once it is approved: a fixed amount, or a percentage of the application&apos;s fees. None apply until you set them
            (open question for the owner).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data.types.map((t) => {
            const r = data.rules.find((x) => x.typeKey === t.key);
            return (
              <ActionForm key={t.key} action={saveCommissionRuleAction} className="grid items-center gap-2 sm:grid-cols-[1fr_8rem_8rem_7rem_auto_auto]">
                <input type="hidden" name="typeKey" value={t.key} />
                <span className="text-sm">{t.label}</span>
                <Select name="mode" defaultValue={r?.mode ?? "percent"} aria-label="Mode">
                  <option value="percent">% of fees</option>
                  <option value="fixed">Fixed ₱</option>
                </Select>
                <Input name="amount" inputMode="decimal" defaultValue={r && r.mode === "fixed" ? toDecimalString(r.amountCentavos) : ""} placeholder="Fixed ₱" aria-label="Fixed amount" />
                <Input name="ratePct" inputMode="decimal" defaultValue={r && r.mode === "percent" ? pct(r.rateBps) : ""} placeholder="%" aria-label="Percent" />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" name="active" defaultChecked={r?.active ?? false} className="size-4" /> Active
                </label>
                <Button type="submit" variant="outline" size="sm">
                  Save
                </Button>
              </ActionForm>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
