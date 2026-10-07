import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase/client';
import { useAuth } from '@/features/auth/useAuth';
import type { AppRole } from '@/features/auth/roles';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी (Hindi)' },
  { value: 'or', label: 'ଓଡ଼ିଆ (Odia)' },
];

export function SettingsPage({ role }: { role: AppRole }) {
  const { user, profile, refreshProfile } = useAuth();
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState('en');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.display_name ?? '');
    setLanguage(profile?.preferred_language ?? 'en');
  }, [profile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: displayName.trim() || null, preferred_language: language })
      .eq('id', user.id);
    setSaving(false);
    if (error) {
      toast({ title: 'Could not save', description: error.message, variant: 'destructive' });
      return;
    }
    await refreshProfile();
    toast({ title: 'Profile saved' });
  };

  return (
    <DashboardLayout role={role}>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>{user?.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">Name</Label>
              <Input
                id="displayName"
                value={displayName}
                maxLength={100}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="language">Preferred language</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </DashboardLayout>
  );
}
