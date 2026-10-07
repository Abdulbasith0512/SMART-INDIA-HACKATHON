import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Home, Users, Settings, LogOut, Activity } from 'lucide-react';
import { useAuth } from '@/features/auth/useAuth';
import { ROLE_BASE_PATH, ROLE_LABEL, type AppRole } from '@/features/auth/roles';

interface DashboardSidebarProps {
  role: AppRole;
}

const sidebarItems = (role: AppRole) => {
  const base = ROLE_BASE_PATH[role];
  const items = [{ icon: Home, label: 'Home', path: base }];
  if (role === 'admin') {
    items.push({ icon: Users, label: 'Manage Users', path: '/admin/users' });
  }
  return items;
};

export const DashboardSidebar = ({ role }: DashboardSidebarProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const items = sidebarItems(role);
  const settingsPath = `${ROLE_BASE_PATH[role]}/settings`;

  const isActive = (path: string) => location.pathname === path;

  const handleLogout = async () => {
    await signOut();
    navigate('/', { replace: true });
  };

  return (
    <motion.aside
      initial={{ x: -250 }}
      animate={{ x: 0 }}
      className="fixed left-0 top-0 h-full w-64 glass-card border-r border-glass-border backdrop-blur-xl z-40"
    >
      <div className="p-6">
        <div className="flex items-center space-x-3 mb-8">
          <div className="p-2 rounded-lg bg-gradient-primary">
            <Activity className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-bold">JanSanket</h2>
            <p className="text-xs text-muted-foreground">{ROLE_LABEL[role]}</p>
          </div>
        </div>

        <nav className="space-y-2">
          {items.map((item) => (
            <Button
              key={item.path}
              asChild
              variant={isActive(item.path) ? 'default' : 'ghost'}
              className={`w-full justify-start ${
                isActive(item.path)
                  ? 'bg-primary text-primary-foreground shadow-glow-primary'
                  : 'glass hover:bg-primary/10'
              }`}
            >
              <Link to={item.path}>
                <item.icon className="mr-3 h-4 w-4" />
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>

        <div className="absolute bottom-6 left-6 right-6 space-y-2">
          <Button
            asChild
            variant="ghost"
            className={`w-full justify-start ${
              isActive(settingsPath)
                ? 'bg-primary text-primary-foreground shadow-glow-primary'
                : 'glass hover:bg-primary/10'
            }`}
          >
            <Link to={settingsPath}>
              <Settings className="mr-3 h-4 w-4" />
              Settings
            </Link>
          </Button>
          <Button variant="destructive" className="w-full justify-start" onClick={handleLogout}>
            <LogOut className="mr-3 h-4 w-4" />
            Logout
          </Button>
        </div>
      </div>
    </motion.aside>
  );
};
