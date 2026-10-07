import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/useAuth';
import { ROLE_LABEL, type AppRole } from '@/features/auth/roles';

/** Placeholder home for roles whose real features arrive in later milestones. No data is shown. */
export function PlaceholderDashboard({ role }: { role: AppRole }) {
  const { profile, user } = useAuth();
  const name = profile?.display_name || user?.email || 'there';

  return (
    <DashboardLayout role={role}>
      <Card>
        <CardHeader>
          <CardTitle>Welcome, {name}</CardTitle>
          <CardDescription>{ROLE_LABEL[role]} workspace</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          Features for this role arrive in a later milestone.
        </CardContent>
      </Card>
    </DashboardLayout>
  );
}
