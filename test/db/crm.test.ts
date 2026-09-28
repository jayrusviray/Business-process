import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { mapLeadFields } from "@/lib/meta-leads";
import {
  addFollowup,
  completeFollowup,
  createLead,
  eraseLead,
  importLeadsCsv,
  recordInquiry,
  setLeadStage,
} from "@/server/crm/leads";
import { ingestFacebookLead } from "@/server/crm/meta";
import { hashIp, RateLimitedError, submitInquiry } from "@/server/public/inquiry";
import { loadSiteContent } from "@/server/public/site";
import { staffDirectory } from "@/server/queries/staff";
import { as, schema, withSystemTx, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { leads, leadFollowups, notifications } = schema;
let admin: string, finance: string, ops: string, agentA: string, agentB: string, driverUser: string;

const mobile = () => `0917${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

beforeAll(async () => {
  admin = await createUser("C Admin", ["owner_admin"]);
  finance = await createUser("C Finance", ["finance"]);
  ops = await createUser("C Ops", ["operations"]);
  agentA = await createUser("C Agent A", ["sales"]);
  agentB = await createUser("C Agent B", ["sales"]);
  driverUser = await createUser("C Driver", ["driver"]);
});

afterAll(async () => {
  await sql.end();
});

describe("leads", () => {
  it("assigns new leads to the least busy agent and notifies them", async () => {
    // Give agent A an open lead so B is less busy.
    await withUserTx(as(ops), (tx) => createLead(tx, { name: "Busy A", mobile: mobile(), source: "walk_in", interest: "franchise", assignedTo: agentA }));
    const loads = await sql`SELECT id, open_leads FROM app.lead_agent_load()`;
    const minLoad = Math.min(...loads.map((l) => l.open_leads));
    const res = await withUserTx(as(ops), (tx) =>
      createLead(tx, { name: "Auto Assigned", mobile: mobile(), source: "messenger", interest: "activation", message: "Hi, inDrive activation po" }),
    );
    const chosen = loads.find((l) => l.id === res.assignedTo);
    expect(chosen?.open_leads).toBe(minLoad);
    const [n] = await sql`SELECT title, link FROM public.notifications WHERE user_id = ${res.assignedTo} AND link = ${`/app/crm/${res.id}`}`;
    expect(n.title).toBe("New lead: Auto Assigned");
    const acts = await sql`SELECT kind, body FROM public.lead_activities WHERE lead_id = ${res.id}`;
    expect(acts).toEqual([{ kind: "inquiry", body: "Hi, inDrive activation po" }]);
  });

  it("merges a repeat inquiry into the open lead with the same mobile", async () => {
    const m = mobile();
    const first = await withUserTx(as(agentA), (tx) => createLead(tx, { name: "Repeat", mobile: m, source: "messenger", interest: "franchise", assignedTo: agentA }));
    const again = await withSystemTx("test:inquiry", (tx) =>
      recordInquiry(tx, { name: "Repeat Person", mobile: `+63 ${m.slice(1)}`, source: "landing_page", interest: "franchise", message: "Follow up on CPC", consentAt: new Date() }),
    );
    expect(again).toEqual({ leadId: first.id, duplicate: true });
    const [lead] = await sql`SELECT consent_at IS NOT NULL AS consent FROM public.leads WHERE id = ${first.id}`;
    expect(lead.consent).toBe(true);
    const [act] = await sql`SELECT kind, body FROM public.lead_activities WHERE lead_id = ${first.id} AND kind = 'inquiry'`;
    expect(act.body).toContain("Follow up on CPC");
    // Once the lead is closed, a new inquiry starts a new lead.
    await withUserTx(as(agentA), (tx) => setLeadStage(tx, { leadId: first.id, stageKey: "lost", lostReason: "No budget" }));
    const fresh = await withSystemTx("test:inquiry", (tx) => recordInquiry(tx, { name: "Repeat", mobile: m, source: "landing_page", interest: "franchise" }));
    expect(fresh.duplicate).toBe(false);
  });

  it("logs stage and assignment changes; losing needs a reason; winning stamps converted_at", async () => {
    const { id } = await withUserTx(as(agentA), (tx) => createLead(tx, { name: "Stage Test", fbName: "Stage T", source: "facebook_page", interest: "vehicle_program", assignedTo: agentA }));
    await expectDbError(withUserTx(as(agentA), (tx) => setLeadStage(tx, { leadId: id, stageKey: "lost" })), /Why was this lead lost/);
    await expectDbError(
      withUserTx(as(agentA), (tx) => tx.update(leads).set({ stageKey: "lost" }).where(eq(leads.id, id))),
      /give a reason/,
    );
    await withUserTx(as(agentA), (tx) => setLeadStage(tx, { leadId: id, stageKey: "contacted" }));
    await withUserTx(as(agentA), (tx) => tx.update(leads).set({ assignedTo: agentB }).where(eq(leads.id, id)));
    await withUserTx(as(agentB), (tx) => setLeadStage(tx, { leadId: id, stageKey: "converted" }));
    const acts = await sql`SELECT kind, body, created_by FROM public.lead_activities WHERE lead_id = ${id} ORDER BY created_at, kind`;
    expect(acts.map((a) => [a.kind, a.body])).toEqual([
      ["stage_change", "New → Contacted"],
      ["assignment", "Assigned to C Agent B"],
      ["stage_change", "Contacted → Converted"],
    ]);
    expect(acts[2].created_by).toBe(agentB);
    const [l] = await sql`SELECT converted_at IS NOT NULL AS won FROM public.leads WHERE id = ${id}`;
    expect(l.won).toBe(true);
    await expectDbError(sql`UPDATE public.lead_activities SET body = 'x' WHERE lead_id = ${id}`, /append-only/);
  });

  it("requires some way to contact the lead", async () => {
    await expectDbError(withUserTx(as(agentA), (tx) => createLead(tx, { name: "Ghost", source: "other", interest: "other" })), /mobile number, email or Facebook/);
    await expectDbError(sql`INSERT INTO public.leads (name, source) VALUES ('Ghost', 'other')`, /leads_contact_required/);
  });
});

describe("follow-ups", () => {
  it("are completed once, and completing can schedule the next one", async () => {
    const { id: leadId } = await withUserTx(as(agentA), (tx) => createLead(tx, { name: "Follow", mobile: mobile(), source: "referral", interest: "fleet", assignedTo: agentA }));
    const fId = await withUserTx(as(agentA), (tx) => addFollowup(tx, { leadId, dueOn: isoDate("2026-10-01"), note: "Send requirements", assignedTo: agentA }));
    await expectDbError(
      withUserTx(as(agentA), (tx) => tx.update(leadFollowups).set({ dueOn: "2026-12-01" }).where(eq(leadFollowups.id, fId))),
      /permission denied|only be marked done/,
    );
    await withUserTx(as(agentA), (tx) => completeFollowup(tx, { id: fId, outcome: "Sent via Messenger", actorId: agentA, next: { dueOn: isoDate("2026-10-05"), note: "Check docs" } }));
    await expectDbError(withUserTx(as(agentA), (tx) => completeFollowup(tx, { id: fId, outcome: "again", actorId: agentA })), /already done/);
    const open = await sql`SELECT due_on::text, note, assigned_to FROM public.lead_followups WHERE lead_id = ${leadId} AND done_at IS NULL`;
    expect(open).toEqual([{ due_on: "2026-10-05", note: "Check docs", assigned_to: agentA }]);
    const [done] = await sql`SELECT body FROM public.lead_activities WHERE lead_id = ${leadId} AND kind = 'follow_up_done'`;
    expect(done.body).toBe("Send requirements → Sent via Messenger");
  });
});

describe("access", () => {
  it("finance and drivers can't see leads; notifications are private", async () => {
    const { id } = await withUserTx(as(agentA), (tx) => createLead(tx, { name: "Private", mobile: mobile(), source: "tiktok", interest: "other", assignedTo: agentB }));
    expect(await withUserTx(as(finance), (tx) => tx.select().from(leads).where(eq(leads.id, id)))).toEqual([]);
    expect(await withUserTx(as(driverUser), (tx) => tx.select().from(leads).where(eq(leads.id, id)))).toEqual([]);
    await expectDbError(withUserTx(as(finance), (tx) => tx.insert(leads).values({ name: "X", mobile: "09170000000", source: "other" })), /row-level security/);
    const mine = await withUserTx(as(agentA), (tx) => tx.select().from(notifications).where(eq(notifications.link, `/app/crm/${id}`)));
    expect(mine).toEqual([]); // the notification went to agent B
    const theirs = await withUserTx(as(agentB), (tx) => tx.select().from(notifications).where(eq(notifications.link, `/app/crm/${id}`)));
    expect(theirs).toHaveLength(1);
  });

  it("the staff directory is visible to staff only", async () => {
    const seenBySales = await withUserTx(as(agentA), (tx) => staffDirectory(tx));
    expect(seenBySales.find((s) => s.id === finance)?.roles).toEqual(["finance"]);
    expect(seenBySales.some((s) => s.id === driverUser)).toBe(false);
    expect(await withUserTx(as(driverUser), (tx) => staffDirectory(tx))).toEqual([]);
  });
});

describe("erasure (RA 10173)", () => {
  it("owner/admin erases a lead with its history and notifications; the request is logged", async () => {
    const { id } = await withUserTx(as(agentA), (tx) =>
      createLead(tx, { name: "Erase Me", mobile: mobile(), source: "messenger", interest: "franchise", message: "hello", assignedTo: agentB }),
    );
    await withUserTx(as(agentA), (tx) => addFollowup(tx, { leadId: id, dueOn: isoDate("2026-10-10"), note: "x", assignedTo: agentA }));
    await expectDbError(withUserTx(as(agentA), (tx) => eraseLead(tx, { leadId: id, handledBy: agentA, notes: "" })), /not found|not allowed/);
    await withUserTx(as(admin), (tx) => eraseLead(tx, { leadId: id, handledBy: admin, notes: "Request #1" }));
    const left = await sql`
      SELECT (SELECT count(*) FROM public.leads WHERE id = ${id})::int AS leads,
        (SELECT count(*) FROM public.lead_activities WHERE lead_id = ${id})::int AS acts,
        (SELECT count(*) FROM public.lead_followups WHERE lead_id = ${id})::int AS fups,
        (SELECT count(*) FROM public.notifications WHERE link = ${`/app/crm/${id}`})::int AS notes,
        (SELECT count(*) FROM public.privacy_requests WHERE subject_id = ${id} AND kind = 'erase')::int AS logged`;
    expect(left[0]).toEqual({ leads: 0, acts: 0, fups: 0, notes: 0, logged: 1 });
  });
});

describe("CSV import", () => {
  it("previews without writing, blocks on errors, and merges duplicates on import", async () => {
    const existing = mobile();
    await withUserTx(as(agentA), (tx) => createLead(tx, { name: "Existing", mobile: existing, source: "messenger", interest: "franchise", assignedTo: agentA }));
    const fresh = mobile();
    const good = `Name,Mobile,Source,Interest\nNew One,${fresh},Facebook,franchise\nOld One,${existing},walk-in,activation\n`;
    const before = await sql`SELECT count(*)::int AS n FROM public.leads`;
    const preview = await withUserTx(as(agentA), (tx) => importLeadsCsv(tx, { csvText: good, commit: false, assignTo: agentA }));
    expect(preview.committed).toBe(false);
    expect(preview.rows.map((r) => [r.name, r.duplicateOf ?? null, r.error ?? null])).toEqual([
      ["New One", null, null],
      ["Old One", "Existing", null],
    ]);
    expect((await sql`SELECT count(*)::int AS n FROM public.leads`)[0].n).toBe(before[0].n);
    const bad = await withUserTx(as(agentA), (tx) => importLeadsCsv(tx, { csvText: `${good}Bad,12345,,\n`, commit: true, assignTo: null }));
    expect(bad.committed).toBe(false);
    const done = await withUserTx(as(agentA), (tx) => importLeadsCsv(tx, { csvText: good, commit: true, assignTo: agentA }));
    expect([done.created, done.merged]).toEqual([1, 1]);
  });
});

describe("website inquiries", () => {
  it("creates a lead with consent, then rate-limits the visitor", async () => {
    const ip = hashIp(`203.0.113.${Math.floor(Math.random() * 200)}`);
    const base = { name: "Web Visitor", email: null, location: "Makati", interest: "franchise" as const, preferredContact: "call" as const, message: "PA po" };
    const res = await submitInquiry({ ...base, mobile: mobile() }, ip);
    const [lead] = await sql`SELECT source, consent_at IS NOT NULL AS consent, created_by FROM public.leads WHERE id = ${res.leadId}`;
    expect(lead).toEqual({ source: "landing_page", consent: true, created_by: null });
    for (let i = 0; i < 4; i++) await submitInquiry({ ...base, mobile: mobile() }, ip);
    await expect(submitInquiry({ ...base, mobile: mobile() }, ip)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("hashes IPs deterministically without revealing them", () => {
    expect(hashIp("198.51.100.7")).toBe(hashIp("198.51.100.7"));
    expect(hashIp("198.51.100.7")).not.toContain("198");
    expect(hashIp("198.51.100.7")).toHaveLength(32);
  });

  it("loads the seeded website content", async () => {
    const site = await loadSiteContent();
    expect(site.hero?.title).toMatch(/TNVS/);
    expect(site.services.length).toBeGreaterThanOrEqual(4);
    expect(site.requirements[0].body.split("\n").length).toBeGreaterThan(1);
    expect(site.privacy?.body).toMatch(/RA 10173/);
    expect(site.facebookUrl).toBe("https://www.facebook.com/profile.php?id=61561492040341");
  });
});

describe("Facebook Lead Ads", () => {
  it("stores each submission once, merging into an open lead with the same mobile", async () => {
    const m = mobile();
    const mapped = mapLeadFields([
      { name: "full_name", values: ["FB Person"] },
      { name: "phone_number", values: [m] },
      { name: "which_service", values: ["CPC renewal"] },
    ]);
    const id = `lg${Math.floor(Math.random() * 1e9)}`;
    expect(await withSystemTx("test:meta", (tx) => ingestFacebookLead(tx, { leadgenId: id, mapped, createdTime: new Date() }))).toBe("created");
    expect(await withSystemTx("test:meta", (tx) => ingestFacebookLead(tx, { leadgenId: id, mapped, createdTime: new Date() }))).toBe("duplicate");
    const [lead] = await sql`SELECT source, interest, message FROM public.leads WHERE external_ref = ${`fb:${id}`}`;
    expect(lead).toEqual({ source: "fb_lead_ad", interest: "franchise", message: "which service: CPC renewal" });
    const id2 = `${id}b`;
    expect(await withSystemTx("test:meta", (tx) => ingestFacebookLead(tx, { leadgenId: id2, mapped, createdTime: null }))).toBe("merged");
    expect(await withSystemTx("test:meta", (tx) => ingestFacebookLead(tx, { leadgenId: id2, mapped, createdTime: null }))).toBe("duplicate");
    const [{ n }] = await withUserTx(as(admin), (tx) => tx.execute<{ n: number }>(dsql`SELECT count(*)::int AS n FROM public.lead_activities WHERE meta ->> 'externalRef' = ${`fb:${id2}`}`));
    expect(n).toBe(1);
  });
});
