import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { User, Lock, ArrowRight } from 'lucide-react';
// ThreeBackground removed to fix WebGLRenderer context lost error
import { FloatingIcons } from '@/components/FloatingIcons';
import { supabase } from '@/integrations/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { insertTestUsers } from '@/scripts/insertTestUsers';

export default function Login() {
  const [selectedRole, setSelectedRole] = useState('user');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { login } = useAuth();

  const handleInsertTestUsers = async () => {
    try {
      setLoading(true);
      await insertTestUsers();
      toast({
        title: 'Test users created',
        description: 'Test users have been added to the database',
        variant: 'default',
      });
    } catch (error) {
      console.error('Error inserting test users:', error);
      toast({
        title: 'Error',
        description: 'Failed to create test users',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const formData = new FormData(e.target as HTMLFormElement);
      const email = formData.get('email') as string;
      const password = formData.get('password') as string;

      // Simple validation for demo purposes
      if (!email || !password) {
        toast({
          title: 'Login failed',
          description: 'Please enter both email and password',
          variant: 'destructive',
        });
        return;
      }

      // Use the new authentication system
      await login(email, selectedRole as 'user' | 'doctor' | 'admin');
      
      toast({
        title: 'Login successful',
        description: 'Welcome back!',
        variant: 'default',
      });

      // Redirect based on role using navigate for proper routing
      setTimeout(() => {
        if (selectedRole === 'user') {
          navigate('/dashboard');
        } else if (selectedRole === 'doctor') {
          navigate('/doctor-dashboard');
        } else if (selectedRole === 'admin') {
          navigate('/admin-dashboard');
        }
      }, 500); // Small delay to allow toast to be seen
    } catch (error) {
      console.error('Login error:', error);
      toast({
        title: 'Login failed',
        description: 'User not found or invalid credentials',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* ThreeBackground removed to fix WebGLRenderer context lost error */}
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
            <CardTitle className="text-2xl font-bold">Welcome Back</CardTitle>
            <CardDescription>Sign in to your account to continue</CardDescription>
          </CardHeader>
          
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="role">Login as</Label>
                <Select value={selectedRole} onValueChange={setSelectedRole}>
                  <SelectTrigger className="glass border-glass-border">
                    <SelectValue placeholder="Select your role" />
                  </SelectTrigger>
                  <SelectContent className="glass-card border-glass-border backdrop-blur-xl">
                    <SelectItem value="user">Patient</SelectItem>
                    <SelectItem value="doctor">Doctor</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="Enter your email (test@example.com)"
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
                  placeholder="Enter password (any password works)"
                  className="glass border-glass-border backdrop-blur-sm"
                  required
                />
              </div>
              
              <Button 
                type="submit" 
                className="w-full" 
                variant="hero" 
                size="lg"
                disabled={loading}
              >
                {loading ? (
                  <>Loading...</>
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
          
          <CardFooter className="text-center space-y-4">
            <Button 
              type="button"
              onClick={handleInsertTestUsers}
              variant="outline"
              size="sm"
              disabled={loading}
              className="w-full"
            >
              Create Test Users
            </Button>
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