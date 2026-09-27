import { asc, desc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { appSettings, govContributionTables } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { GOV_AGENCY_LABELS, type GovAgency } from "@/lib/settings/gov-tables";
import { isSettingKey, settingsRegistry } from "@/lib/settings/registry";
import { addGovTable, updateSetting } from "../actions";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireRole(["owner_admin"]);
  const { settings, govTables } = await withUserTx(session.claims, async (tx) => ({
    settings: await tx.select().from(appSettings).orderBy(asc(appSettings.key)),
    govTables: await tx
      .select()
      .from(govContributionTables)
      .orderBy(asc(govContributionTables.agency), desc(govContributionTables.effectiveFrom)),
  }));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Business rules live here, not in code. Every change is recorded in the audit log."
      />

      <div className="grid gap-4">
        {settings.map((s) => {
          const def = isSettingKey(s.key) ? settingsRegistry[s.key] : undefined;
          const readOnly = !def || ("readOnly" in def && def.readOnly);
          return (
            <Card key={s.key}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{def?.label ?? s.key}</CardTitle>
                  <Badge variant="muted">{def?.group ?? "Unregistered"}</Badge>
                  <code className="text-xs text-muted-foreground">{s.key}</code>
                </div>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <ActionForm action={updateSetting} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <input type="hidden" name="key" value={s.key} />
                  <Textarea
                    name="value"
                    defaultValue={JSON.stringify(s.value, null, 2)}
                    rows={Math.min(8, JSON.stringify(s.value, null, 2).split("\n").length)}
                    readOnly={readOnly}
                    aria-label={`${s.key} value (JSON)`}
                  />
                  {readOnly ? null : (
                    <Button type="submit" variant="outline">
                      Save
                    </Button>
                  )}
                </ActionForm>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-2 mt-10 text-lg font-semibold">Government contribution tables</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Versioned by effective date. To change a rate, add a new version; payroll uses the latest version effective
        on the period end date. Seeded values must be verified by your accountant before the first live payroll.
      </p>
      <div className="grid gap-4">
        {govTables.map((g) => (
          <Card key={g.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{GOV_AGENCY_LABELS[g.agency as GovAgency]}</CardTitle>
                <Badge variant="muted">effective {g.effectiveFrom}</Badge>
              </div>
              <CardDescription>{g.notes}</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(g.config, null, 2)}</pre>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader>
            <CardTitle>Add a new version</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={addGovTable} className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agency">Agency</Label>
                  <Select id="agency" name="agency">
                    {Object.entries(GOV_AGENCY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="effectiveFrom">Effective from</Label>
                  <Input id="effectiveFrom" name="effectiveFrom" type="date" required />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="config">Config (JSON, same shape as the current version)</Label>
                <Textarea id="config" name="config" rows={6} required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="notes">Notes / source</Label>
                <Input id="notes" name="notes" placeholder="e.g. SSS Circular 2026-xxx" />
              </div>
              <Button type="submit" className="justify-self-start">
                Add version
              </Button>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
