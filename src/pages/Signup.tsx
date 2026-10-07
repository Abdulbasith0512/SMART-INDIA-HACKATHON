import { motion } from 'framer-motion';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UserPlus, ArrowRight } from 'lucide-react';
import { FloatingIcons } from '@/components/FloatingIcons';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/features/auth/useAuth';

const MIN_PASSWORD_LENGTH = 8;

export default function Signup() {
  const [loading, setLoading] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { signUp, user, isLoading } = useAuth();

  if (!isLoading && user) {
    return <Navigate to="/app" replace />;
  }

  const handleSignup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const displayName = String(formData.get('displayName') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const confirmPassword = String(formData.get('confirmPassword') ?? '');

    if (password.length < MIN_PASSWORD_LENGTH) {
      toast({
        title: 'Weak password',
        description: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
        variant: 'destructive',
      });
      return;
    }
    if (password !== confirmPassword) {
      toast({ title: 'Passwords do not match', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      // No role is sent. Every new account is a citizen; roles are granted by admins only.
      const { needsEmailConfirmation } = await signUp(email, password, displayName);
      if (needsEmailConfirmation) {
        setConfirmationSent(true);
      } else {
        navigate('/app', { replace: true });
      }
    } catch (error) {
      toast({
        title: 'Sign up failed',
        description: error instanceof Error ? error.message : 'Could not create the account.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-blue-50 to-indigo-100">
      <FloatingIcons />

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        <Card className="glass-card border-glass-border backdrop-blur-xl">
          <CardHeader className="text-center">
            <motion.div
              initial={{ y: -20 }}
              animate={{ y: 0 }}
              transition={{ delay: 0.2 }}
              className="p-3 rounded-full bg-gradient-healthcare w-16 h-16 mx-auto mb-4"
            >
              <UserPlus className="h-10 w-10 text-healthcare-green-foreground" />
            </motion.div>
            <CardTitle className="text-2xl font-bold">Create account</CardTitle>
            <CardDescription>Join JanSanket as a community member</CardDescription>
          </CardHeader>

          <CardContent>
            {confirmationSent ? (
              <p className="text-center text-sm" role="status">
                Check your email for a confirmation link, then{' '}
                <Link to="/login" className="text-primary hover:underline font-medium">
                  sign in
                </Link>
                .
              </p>
            ) : (
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="displayName">Name</Label>
                  <Input
                    id="displayName"
                    name="displayName"
                    autoComplete="name"
                    maxLength={100}
                    className="glass border-glass-border backdrop-blur-sm"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    className="glass border-glass-border backdrop-blur-sm"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    className="glass border-glass-border backdrop-blur-sm"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm password</Label>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    className="glass border-glass-border backdrop-blur-sm"
                    required
                  />
                </div>

                <Button type="submit" className="w-full" variant="healthcare" size="lg" disabled={loading}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  {loading ? 'Creating account...' : 'Create account'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </form>
            )}
          </CardContent>

          <CardFooter className="text-center">
            <p className="text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="text-primary hover:underline font-medium">
                Sign in here
              </Link>
            </p>
          </CardFooter>
        </Card>
      </motion.div>
    </div>
  );
}
