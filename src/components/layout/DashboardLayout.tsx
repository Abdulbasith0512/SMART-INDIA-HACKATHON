import { ReactNode } from 'react';
import { motion } from 'framer-motion';
// ThreeBackground removed to fix WebGLRenderer context lost error
import { DashboardSidebar } from './DashboardSidebar';

interface DashboardLayoutProps {
  children: ReactNode;
  userType: 'user' | 'doctor' | 'admin';
}

export const DashboardLayout = ({ children, userType }: DashboardLayoutProps) => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* ThreeBackground removed to fix WebGLRenderer context lost error */}
      <div className="flex">
        <DashboardSidebar userType={userType} />
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