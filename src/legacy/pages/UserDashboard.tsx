import { motion } from 'framer-motion';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, Users, MessageCircle, Clock, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { supabase as supabaseClient } from '@/integrations/client';
import { Appointment, User } from '@/integrations/types';

// Local implementation of getDoctors
const getDoctors = async () => {
  const { data, error } = await supabaseClient
    .from('users')
    .select(`
      *,
      doctor_details (
        specialization,
        qualification,
        experience,
        availability
      )
    `)
    .eq('role', 'doctor');

  if (error) {
    console.error('Error fetching doctors:', error);
    return [];
  }

  return data || [];
};
import { Skeleton } from '@/components/ui/skeleton';
import { useNavigate } from 'react-router-dom';

export default function UserDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [messages, setMessages] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        // Check if user is logged in using localStorage
        const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
        const userEmail = localStorage.getItem('userEmail');
        const userRole = localStorage.getItem('userRole');
        
        if (!isLoggedIn || !userEmail || userRole !== 'user') {
          navigate('/login');
          return;
        }
        
        // Get user data from Supabase
        let userData;
        try {
          const userResponse = await supabase
            .from('users')  
            .select('*');
          
          userData = userResponse.data?.find(u => u.email === userEmail);
          
          if (!userData) {
            // Fallback to localStorage data if Supabase fetch fails
            const fallbackUser = {
              id: 1,
              email: userEmail,
              role: 'user',
              first_name: 'Test',
              last_name: 'User'
            };
            setUser({
              id: fallbackUser.id,
              name: `${fallbackUser.first_name} ${fallbackUser.last_name}`,
              email: fallbackUser.email,
              password: '',
              role: 'user' as const,
              created_at: new Date().toISOString()
            });
          } else {
            setUser(userData as User);
          }
        } catch (error) {
          console.error('Error fetching user data:', error);
          // Fallback user
          const fallbackUser = {
            id: 1,
            email: userEmail || 'user@example.com',
            role: 'user',
            first_name: 'Test',
            last_name: 'User'
          };
          setUser({
            id: fallbackUser.id,
            name: `${fallbackUser.first_name} ${fallbackUser.last_name}`,
            email: fallbackUser.email,
            password: '',
            role: 'user' as const,
            created_at: new Date().toISOString()
          });
        }
        
        // Get real appointments data from Supabase
        const userId = userData?.id || 1;
        try {
          const appointmentsResponse = await supabase
            .from('appointments')
            .select('*');
          
          const appointmentsData = appointmentsResponse.data?.filter(a => a.user_id === userId) || [];
          setAppointments(appointmentsData);
        } catch (error) {
          console.error('Error fetching appointments:', error);
          setAppointments([]);
        }
        
        // Get messages count from Supabase
        try {
          const messagesResponse = await supabase
            .from('messages')
            .select('*');
          
          const messagesData = messagesResponse.data?.filter(m => m.user_id === userId) || [];
          setMessages(messagesData.length);
        } catch (error) {
          console.error('Error fetching messages:', error);
          setMessages(0);
        }
        
        // Get real doctors data from Supabase (doctors are users with role='doctor')
        try {
          const doctorsData = await getDoctors();
          setDoctors(doctorsData || []);
        } catch (error) {
          console.error('Error fetching doctors:', error);
          setDoctors([]);
        }
      } catch (error) {
        console.error('Error setting up dashboard:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUserData();
  }, [navigate]);

  // Calculate stats dynamically
  const stats = [
    { icon: Calendar, label: 'Appointments', value: appointments.length.toString(), color: 'text-primary' },
    { icon: Users, label: 'Doctors', value: doctors.length.toString(), color: 'text-healthcare-green' },
    { icon: MessageCircle, label: 'Messages', value: messages.toString(), color: 'text-blue-500' },
    { icon: Clock, label: 'Pending', value: appointments.filter(app => app.status === 'pending').length.toString(), color: 'text-orange-500' },
  ];

  // Format appointments for display
  const formattedAppointments = appointments.map(appointment => {
    const doctor = doctors.find(d => d.id === appointment.doctor_id);
    
    return {
      id: appointment.id,
      doctor: doctor ? `Dr. ${doctor.first_name} ${doctor.last_name}` : 'Unknown Doctor',
      specialty: doctor?.specialty || 'Specialist',
      date: new Date(appointment.created_at || Date.now()).toLocaleString(),
      time: '12:00 PM',
      type: appointment.status || 'pending'
    };
  });

  const handleBookAppointment = () => {
    navigate('/doctors');
  };

  if (loading) {
    return (
      <DashboardLayout userType="user">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Skeleton className="h-10 w-64 mb-2" />
              <Skeleton className="h-4 w-48" />
            </div>
            <Skeleton className="h-10 w-40" />
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map(i => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
          
          <Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout userType="user">
      <div className="space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div>
            <h1 className="text-3xl font-bold">Welcome back, {user?.name || 'User'}!</h1>
            <p className="text-muted-foreground">Here's your health dashboard overview</p>
          </div>
          <Button variant="hero" size="lg" onClick={handleBookAppointment}>
            <Plus className="mr-2 h-4 w-4" />
            Book Appointment
          </Button>
        </motion.div>

        {/* Stats Cards */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {stats.map((stat, index) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + index * 0.1 }}
            >
              <Card className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">{stat.label}</p>
                      <p className="text-3xl font-bold">{stat.value}</p>
                    </div>
                    <stat.icon className={`h-8 w-8 ${stat.color}`} />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        {/* Upcoming Appointments */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="glass-card border-glass-border">
            <CardHeader>
              <CardTitle className="flex items-center">
                <Calendar className="mr-2 h-5 w-5" />
                Upcoming Appointments
              </CardTitle>
            </CardHeader>
            <CardContent>
              {formattedAppointments.length > 0 ? (
                <div className="space-y-4">
                  {formattedAppointments.map((appointment) => (
                    <div
                      key={appointment.id}
                      className="flex items-center justify-between p-4 glass rounded-lg border border-glass-border"
                    >
                      <div className="flex items-center space-x-4">
                        <div className="p-2 rounded-full bg-gradient-primary">
                          <Users className="h-4 w-4 text-primary-foreground" />
                        </div>
                        <div>
                          <h4 className="font-semibold">{appointment.doctor}</h4>
                          <p className="text-sm text-muted-foreground">{appointment.specialty}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{appointment.date}</p>
                        <p className="text-sm text-muted-foreground">{appointment.type}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No upcoming appointments</p>
                  <Button variant="outline" className="mt-4" onClick={handleBookAppointment}>
                    Book Your First Appointment
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}