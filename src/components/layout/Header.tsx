import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Activity, User } from 'lucide-react';
import { useAuth } from '@/features/auth/useAuth';

export const Header = () => {
  const location = useLocation();
  const { user } = useAuth();

  const isActive = (path: string) => location.pathname === path;

  const navLink = (path: string, label: string) => (
    <Link
      to={path}
      className={`text-sm font-medium transition-smooth hover:text-primary ${
        isActive(path) ? 'text-primary' : 'text-muted-foreground'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <motion.header
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      className="fixed top-0 left-0 right-0 z-50 glass-card border-b border-glass-border backdrop-blur-xl"
    >
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center space-x-2 group">
            <div className="p-2 rounded-lg bg-gradient-primary group-hover:shadow-glow-primary transition-smooth">
              <Activity className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">JanSanket</h1>
              <p className="text-xs text-muted-foreground">Community Health Intelligence</p>
            </div>
          </Link>

          <nav className="hidden md:flex items-center space-x-6">
            {navLink('/', 'Home')}
            {navLink('/about', 'About')}
            {navLink('/contact', 'Contact')}
          </nav>

          <div className="flex items-center space-x-3">
            {user ? (
              <Button asChild variant="hero" size="sm">
                <Link to="/app">Open dashboard</Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm" className="glass hover:bg-primary/10">
                  <Link to="/login">
                    <User className="h-4 w-4 mr-2" />
                    Login
                  </Link>
                </Button>
                <Button asChild variant="hero" size="sm">
                  <Link to="/signup">Sign Up</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </motion.header>
  );
};
