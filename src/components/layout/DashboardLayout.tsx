import { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { DashboardSidebar } from './DashboardSidebar';
import type { AppRole } from '@/features/auth/roles';

interface DashboardLayoutProps {
  children: ReactNode;
  role: AppRole;
}

export const DashboardLayout = ({ children, role }: DashboardLayoutProps) => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="flex">
        <DashboardSidebar role={role} />
        <main className="flex-1 ml-64">
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
            className="p-6"
          >
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  );
};
