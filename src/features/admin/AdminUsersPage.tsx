import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase/client';
import { useAuth } from '@/features/auth/useAuth';
import { ROLE_LABEL, type AppRole } from '@/features/auth/roles';

// 'citizen' is implicit for every account and cannot be granted or revoked.
const ASSIGNABLE_ROLES: AppRole[] = ['clinician', 'officer', 'admin'];
const USERS_KEY = ['admin', 'users'] as const;

export default function AdminUsersPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_users', { _limit: 100, _offset: 0 });
      if (error) throw error;
      return data;
    },
  });

  // Authorization is enforced inside the database function; the UI only reflects it.
  const setRole = useMutation({
    mutationFn: async (vars: { target: string; role: AppRole; grant: boolean }) => {
      const { error } = await supabase.rpc('admin_set_user_role', {
        _target: vars.target,
        _role: vars.role,
        _grant: vars.grant,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    onError: (error: Error) =>
      toast({ title: 'Role change failed', description: error.message, variant: 'destructive' }),
  });

  return (
    <DashboardLayout role="admin">
      <Card>
        <CardHeader>
          <CardTitle>Manage users</CardTitle>
          <CardDescription>Grant or revoke roles. You cannot change your own roles.</CardDescription>
        </CardHeader>
        <CardContent>
          {users.isLoading && <p className="text-muted-foreground">Loading…</p>}
          {users.isError && <p className="text-destructive">Could not load users.</p>}
          {users.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Grant / revoke</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.map((u) => {
                  const isSelf = u.user_id === user?.id;
                  return (
                    <TableRow key={u.user_id}>
                      <TableCell>
                        <div className="font-medium">{u.display_name || '(no name)'}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </TableCell>
                      <TableCell className="space-x-1">
                        {u.roles.map((r) => (
                          <Badge key={r} variant="secondary">
                            {ROLE_LABEL[r]}
                          </Badge>
                        ))}
                      </TableCell>
                      <TableCell className="space-x-2">
                        {ASSIGNABLE_ROLES.map((role) => {
                          const has = u.roles.includes(role);
                          return (
                            <Button
                              key={role}
                              size="sm"
                              variant={has ? 'destructive' : 'outline'}
                              disabled={isSelf || setRole.isPending}
                              onClick={() => setRole.mutate({ target: u.user_id, role, grant: !has })}
                            >
                              {has ? `Revoke ${role}` : `Grant ${role}`}
                            </Button>
                          );
                        })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </DashboardLayout>
  );
}
