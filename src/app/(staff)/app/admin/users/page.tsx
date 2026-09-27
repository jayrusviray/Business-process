import { asc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { profiles, userRoles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/auth/roles";
import { changeRole, inviteUser, setUserStatus } from "../actions";

export const metadata = { title: "Users & roles" };

export default async function UsersPage() {
  const session = await requireRole(["owner_admin"]);
  const { people, grants } = await withUserTx(session.claims, async (tx) => ({
    people: await tx.select().from(profiles).orderBy(asc(profiles.fullName)),
    grants: await tx.select({ userId: userRoles.userId, role: userRoles.role }).from(userRoles),
  }));
  const rolesByUser = new Map<string, Role[]>();
  for (const g of grants) rolesByUser.set(g.userId, [...(rolesByUser.get(g.userId) ?? []), g.role]);

  return (
    <>
      <PageHeader title="Users & roles" description="Grant access by role. Permissions are enforced in the database, not just the UI." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Invite a user</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={inviteUser} className="grid gap-3 sm:grid-cols-[1fr_1fr_12rem_auto] sm:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName">Full name</Label>
              <Input id="fullName" name="fullName" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="role">Role</Label>
              <Select id="role" name="role" defaultValue="operations">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit">Send invite</Button>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Roles</Th>
              <Th>Grant role</Th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const roles = rolesByUser.get(p.id) ?? [];
              return (
                <tr key={p.id}>
                  <Td>
                    <div className="font-medium">{p.fullName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{p.email ?? p.phone}</div>
                  </Td>
                  <Td>
                    <ActionForm action={setUserStatus} className="flex items-center gap-2" inlineStatus>
                      <input type="hidden" name="userId" value={p.id} />
                      <input type="hidden" name="status" value={p.status === "active" ? "disabled" : "active"} />
                      <Badge variant={p.status === "active" ? "success" : "destructive"}>{p.status}</Badge>
                      {p.id !== session.userId ? (
                        <Button type="submit" variant="ghost" size="sm">
                          {p.status === "active" ? "Disable" : "Enable"}
                        </Button>
                      ) : null}
                    </ActionForm>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {roles.length === 0 ? <span className="text-xs text-muted-foreground">none</span> : null}
                      {roles.map((r) => (
                        <ActionForm key={r} action={changeRole} inlineStatus className="flex items-center">
                          <input type="hidden" name="userId" value={p.id} />
                          <input type="hidden" name="role" value={r} />
                          <input type="hidden" name="op" value="revoke" />
                          <Badge>
                            {ROLE_LABELS[r]}
                            <button type="submit" className="ml-1 opacity-60 hover:opacity-100" aria-label={`Remove ${ROLE_LABELS[r]}`}>
                              ×
                            </button>
                          </Badge>
                        </ActionForm>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <ActionForm action={changeRole} className="flex gap-2" inlineStatus>
                      <input type="hidden" name="userId" value={p.id} />
                      <input type="hidden" name="op" value="grant" />
                      <Select name="role" className="h-8 w-40">
                        {ROLES.filter((r) => !roles.includes(r)).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" size="sm" variant="outline">
                        Grant
                      </Button>
                    </ActionForm>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
