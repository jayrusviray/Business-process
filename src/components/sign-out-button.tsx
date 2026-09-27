import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="ghost" size="sm">
        Sign out
      </Button>
    </form>
  );
}
