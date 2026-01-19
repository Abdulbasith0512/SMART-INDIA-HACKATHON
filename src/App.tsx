import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Header } from "@/components/layout/Header";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import About from "./pages/About";
import Contact from "./pages/Contact";
import UserDashboard from "./pages/UserDashboard";
import DoctorDashboard from "./pages/DoctorDashboard";
import DoctorPatients from "./pages/DoctorPatients";
import DoctorChats from "./pages/DoctorChats";
import AdminDashboard from "./pages/AdminDashboard";
import DoctorsList from "./pages/DoctorsList";
import ChatInterface from "./pages/ChatInterface";
import BookAppointment from "./pages/BookAppointment";
import { Settings } from "./pages/Settings";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={
            <div>
              <Header />
              <Home />
            </div>
          } />
          <Route path="/about" element={
            <div>
              <Header />
              <About />
            </div>
          } />
          <Route path="/contact" element={
            <div>
              <Header />
              <Contact />
            </div>
          } />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/dashboard" element={<UserDashboard />} />
          <Route path="/dashboard/doctors" element={<DoctorsList />} />
          <Route path="/dashboard/chats" element={<ChatInterface />} />
          <Route path="/dashboard/book-appointment" element={<BookAppointment />} />
          <Route path="/dashboard/settings" element={<Settings />} />
          {/* Direct access routes */}
          <Route path="/doctors" element={<DoctorsList />} />
          <Route path="/book-appointment" element={<BookAppointment />} />
          <Route path="/doctor-dashboard" element={<DoctorDashboard />} />
          <Route path="/doctor-dashboard/patients" element={<DoctorPatients />} />
          <Route path="/doctor-dashboard/chats" element={<DoctorChats />} />
          <Route path="/doctor-dashboard/settings" element={<Settings />} />
          <Route path="/admin-dashboard" element={<AdminDashboard />} />
          <Route path="/admin-dashboard/users" element={<AdminDashboard />} />
          <Route path="/admin-dashboard/doctors" element={<AdminDashboard />} />
          <Route path="/admin-dashboard/settings" element={<Settings />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
