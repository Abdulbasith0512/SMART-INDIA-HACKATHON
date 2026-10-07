import { motion } from 'framer-motion';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { User, Lock, ArrowRight } from 'lucide-react';
import { FloatingIcons } from '@/components/FloatingIcons';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/features/auth/useAuth';

export default function Login() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { signIn, user, isLoading } = useAuth();

  if (!isLoading && user) {
    return <Navigate to="/app" replace />;
  }

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    if (!email || !password) {
      toast({
        title: 'Login failed',
        description: 'Please enter both email and password',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      await signIn(email, password);
      navigate('/app', { replace: true });
    } catch {
      // Deliberately generic: do not reveal whether the email exists.
      toast({
        title: 'Login failed',
        description: 'Invalid email or password',
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
              className="p-3 rounded-full bg-gradient-primary w-16 h-16 mx-auto mb-4"
            >
              <User className="h-10 w-10 text-primary-foreground" />
            </motion.div>
            <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
            <CardDescription>Sign in to JanSanket</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
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
                  autoComplete="current-password"
                  placeholder="Your password"
                  className="glass border-glass-border backdrop-blur-sm"
                  required
                />
              </div>

              <Button type="submit" className="w-full" variant="hero" size="lg" disabled={loading}>
                {loading ? (
                  <>Signing in...</>
                ) : (
                  <>
                    <Lock className="mr-2 h-4 w-4" />
                    Sign In
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="text-center">
            <p className="text-sm text-muted-foreground">
              Don't have an account?{' '}
              <Link to="/signup" className="text-primary hover:underline font-medium">
                Sign up here
              </Link>
            </p>
          </CardFooter>
        </Card>
      </motion.div>
    </div>
  );
}
