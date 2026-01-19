import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { 
  Home, 
  Users, 
  MessageCircle, 
  Calendar,
  Settings,
  LogOut,
  Stethoscope,
  Shield
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface DashboardSidebarProps {
  userType: 'user' | 'doctor' | 'admin';
}

const sidebarItems = {
  user: [
    { icon: Home, label: 'Home', path: '/dashboard' },
    { icon: Users, label: 'Doctors', path: '/dashboard/doctors' },
    { icon: MessageCircle, label: 'Chats', path: '/dashboard/chats' },
  ],
  doctor: [
    { icon: Home, label: 'Home', path: '/doctor-dashboard' },
    { icon: Users, label: 'Patients', path: '/doctor-dashboard/patients' },
    { icon: MessageCircle, label: 'Chats', path: '/doctor-dashboard/chats' },
  ],
  admin: [
    { icon: Home, label: 'Home', path: '/admin-dashboard' },
    { icon: Users, label: 'Manage Users', path: '/admin-dashboard/users' },
    { icon: Stethoscope, label: 'Manage Doctors', path: '/admin-dashboard/doctors' },
  ]
};

export const DashboardSidebar = ({ userType }: DashboardSidebarProps) => {
  const location = useLocation();
  const { logout } = useAuth();
  const items = sidebarItems[userType];
  
  const isActive = (path: string) => location.pathname === path;

  return (
    <motion.aside
      initial={{ x: -250 }}
      animate={{ x: 0 }}
      className="fixed left-0 top-0 h-full w-64 glass-card border-r border-glass-border backdrop-blur-xl z-40"
    >
      <div className="p-6">
        <div className="flex items-center space-x-3 mb-8">
          <div className="p-2 rounded-lg bg-gradient-primary">
            <Stethoscope className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-bold">MediCare</h2>
            <p className="text-xs text-muted-foreground capitalize">{userType} Portal</p>
          </div>
        </div>

        <nav className="space-y-2">
          {items.map((item) => (
            <Button
              key={item.path}
              asChild
              variant={isActive(item.path) ? "default" : "ghost"}
              className={`w-full justify-start ${
                isActive(item.path) 
                  ? "bg-primary text-primary-foreground shadow-glow-primary" 
                  : "glass hover:bg-primary/10"
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
              isActive(`/${userType === 'user' ? 'dashboard' : userType === 'doctor' ? 'doctor-dashboard' : 'admin-dashboard'}/settings`)
                ? "bg-primary text-primary-foreground shadow-glow-primary" 
                : "glass hover:bg-primary/10"
            }`}
          >
            <Link to={`/${userType === 'user' ? 'dashboard' : userType === 'doctor' ? 'doctor-dashboard' : 'admin-dashboard'}/settings`}>
              <Settings className="mr-3 h-4 w-4" />
              Settings
            </Link>
          </Button>
          <Button 
            variant="destructive" 
            className="w-full justify-start"
            onClick={logout}
          >
            <LogOut className="mr-3 h-4 w-4" />
            Logout
          </Button>
        </div>
      </div>
    </motion.aside>
  );
};