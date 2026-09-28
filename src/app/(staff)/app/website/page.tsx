import { asc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { siteBlocks } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { SERVICE_LINE_LABELS, SERVICE_LINES } from "@/lib/crm";
import { deleteBlockAction, saveBlockAction } from "./actions";

export const metadata = { title: "Website" };

type Section = (typeof siteBlocks.$inferSelect)["section"];
const SECTIONS: { key: Section; title: string; help: string; single?: boolean }[] = [
  { key: "hero", title: "Headline", help: "The big headline (title) and the line under it (text).", single: true },
  { key: "service", title: "Services", help: "One card per service. Choose the service line so “Ask about this” pre-fills the form." },
  { key: "audience", title: "Who we serve", help: "Short cards." },
  { key: "step", title: "How it works", help: "Steps, in order." },
  { key: "requirement", title: "Requirements checklist", help: "One block per service. Put one requirement per line in the text." },
  { key: "program", title: "Vehicle programs", help: "Boundary vs rent-to-own explainer." },
  { key: "faq", title: "FAQs", help: "Question as the title, answer as the text." },
  { key: "school", title: "School page (/school)", help: "Placeholder until the school details are ready." },
  { key: "privacy", title: "Privacy notice (/privacy)", help: "Shown with the inquiry form's consent checkbox (RA 10173).", single: true },
];

function BlockForm({ block, section }: { block?: typeof siteBlocks.$inferSelect; section: Section }) {
  return (
    <ActionForm action={saveBlockAction} className="flex flex-col gap-2">
      {block ? <input type="hidden" name="id" value={block.id} /> : null}
      <input type="hidden" name="section" value={section} />
      <Input name="title" defaultValue={block?.title} placeholder="Title" required aria-label="Title" />
      <textarea
        name="body"
        defaultValue={block?.body}
        rows={section === "privacy" ? 10 : section === "requirement" ? 5 : 3}
        placeholder="Text"
        aria-label="Text"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select name="serviceLine" defaultValue={block?.serviceLine ?? ""} className="w-64" aria-label="Service line">
          <option value="">No service line</option>
          {SERVICE_LINES.map((s) => (
            <option key={s} value={s}>
              {SERVICE_LINE_LABELS[s]}
            </option>
          ))}
        </Select>
        <Input name="sort" type="number" defaultValue={block?.sort ?? 100} className="w-24" aria-label="Order" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="active" defaultChecked={block?.active ?? true} className="size-4" /> Shown
        </label>
        <Button type="submit" variant="outline" size="sm">
          {block ? "Save" : "Add"}
        </Button>
      </div>
    </ActionForm>
  );
}

/** Edit the public website without a deploy (owner/admin and sales). */
export default async function WebsiteEditorPage() {
  const session = await requireRole(["owner_admin", "sales"]);
  const blocks = await withUserTx(session.claims, (tx) => tx.select().from(siteBlocks).orderBy(asc(siteBlocks.sort), asc(siteBlocks.title)));
  return (
    <>
      <PageHeader
        title="Website"
        description="The public pages at / , /school and /privacy. Changes show on the next page load."
        actions={
          <Button asChild variant="outline">
            <a href="/" target="_blank" rel="noreferrer">
              View website
            </a>
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {SECTIONS.map((sec) => {
          const items = blocks.filter((b) => b.section === sec.key);
          return (
            <Card key={sec.key}>
              <CardHeader>
                <CardTitle>{sec.title}</CardTitle>
                <CardDescription>{sec.help}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {items.map((b) => (
                  <div key={b.id} className="rounded-md border p-3">
                    {!b.active ? <Badge variant="muted" className="mb-2">hidden</Badge> : null}
                    <BlockForm block={b} section={sec.key} />
                    {!sec.single ? (
                      <ActionForm action={deleteBlockAction} className="mt-2" inlineStatus>
                        <input type="hidden" name="id" value={b.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                          Delete
                        </Button>
                      </ActionForm>
                    ) : null}
                  </div>
                ))}
                {!sec.single || items.length === 0 ? (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">Add to {sec.title.toLowerCase()}</summary>
                    <div className="mt-2">
                      <BlockForm section={sec.key} />
                    </div>
                  </details>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
