import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import type { ReactNode } from "react";
import { Header } from "@/components/layout/Header";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { RequireRole } from "@/features/auth/RequireRole";
import { HomeRedirect } from "@/features/auth/HomeRedirect";
import { PlaceholderDashboard } from "@/features/dashboards/PlaceholderDashboard";
import { SettingsPage } from "@/features/settings/SettingsPage";
import AdminUsersPage from "@/features/admin/AdminUsersPage";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import About from "./pages/About";
import Contact from "./pages/Contact";
import Forbidden from "./pages/Forbidden";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const WithHeader = ({ children }: { children: ReactNode }) => (
  <div>
    <Header />
    {children}
  </div>
);

// NOTE: client-side guards are UX only. Real authorization is enforced by RLS in the database.
const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<WithHeader><Home /></WithHeader>} />
            <Route path="/about" element={<WithHeader><About /></WithHeader>} />
            <Route path="/contact" element={<WithHeader><Contact /></WithHeader>} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/app" element={<HomeRedirect />} />
            <Route path="/forbidden" element={<Forbidden />} />

            <Route path="/dashboard" element={<RequireRole roles={["citizen"]}><PlaceholderDashboard role="citizen" /></RequireRole>} />
            <Route path="/dashboard/settings" element={<RequireRole roles={["citizen"]}><SettingsPage role="citizen" /></RequireRole>} />

            <Route path="/clinician" element={<RequireRole roles={["clinician"]}><PlaceholderDashboard role="clinician" /></RequireRole>} />
            <Route path="/clinician/settings" element={<RequireRole roles={["clinician"]}><SettingsPage role="clinician" /></RequireRole>} />

            <Route path="/officer" element={<RequireRole roles={["officer"]}><PlaceholderDashboard role="officer" /></RequireRole>} />
            <Route path="/officer/settings" element={<RequireRole roles={["officer"]}><SettingsPage role="officer" /></RequireRole>} />

            <Route path="/admin" element={<RequireRole roles={["admin"]}><PlaceholderDashboard role="admin" /></RequireRole>} />
            <Route path="/admin/users" element={<RequireRole roles={["admin"]}><AdminUsersPage /></RequireRole>} />
            <Route path="/admin/settings" element={<RequireRole roles={["admin"]}><SettingsPage role="admin" /></RequireRole>} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
