import { motion } from 'framer-motion';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, Calendar, MessageCircle, Clock, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getAppointments, getDoctorById, getPatients } from '@/lib/supabase';
import { supabase } from '@/integrations/client';
import { Skeleton } from '@/components/ui/skeleton';

// Local implementation of getMessagesBetweenUsers
const getMessagesBetweenUsers = async (userId1: number, userId2: number) => {
  const { data, error } = await supabase
    .from('messages')
    .select(`
      *,
      sender:users!messages_sender_id_fkey(id, name),
      receiver:users!messages_receiver_id_fkey(id, name)
    `)
    .or(`and(sender_id.eq.${userId1},receiver_id.eq.${userId2}),and(sender_id.eq.${userId2},receiver_id.eq.${userId1})`)
    .order('timestamp', { ascending: true });

  if (error) {
    console.error('Error fetching messages:', error);
    return [];
  }

  return data || [];
};
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

export default function DoctorDashboard() {
  const [doctor, setDoctor] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [messageCount, setMessageCount] = useState(0);
  const [pendingReviews, setPendingReviews] = useState(0);
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  
  // Set doctor ID from authenticated user
  useEffect(() => {
    if (user && user.role === 'doctor') {
      setDoctorId(user.id);
    }
  }, [user]);
  
  useEffect(() => {
    if (!doctorId) return;
    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Fetch doctor data from users table
        const { data: doctorData, error: doctorError } = await supabase
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
          .eq('id', doctorId)
          .eq('role', 'doctor')
          .single();
        
        if (doctorError) {
          console.error('Error fetching doctor:', doctorError);
        } else {
          setDoctor(doctorData);
        }
        
        // Fetch appointments for this doctor with patient details
        const { data: appointmentsData, error: appointmentsError } = await supabase
          .from('appointments')
          .select(`
            *,
            patient:users!appointments_user_id_fkey (
              id,
              name,
              email
            )
          `)
          .eq('doctor_id', doctorId);
        
        if (appointmentsError) {
          console.error('Error fetching appointments:', appointmentsError);
        } else {
          setAppointments(appointmentsData || []);
          
          // Extract unique patients from appointments
          const uniquePatients = appointmentsData?.reduce((acc: any[], appointment: any) => {
            if (appointment.patient && !acc.find(p => p.id === appointment.patient.id)) {
              acc.push(appointment.patient);
            }
            return acc;
          }, []) || [];
          
          setPatients(uniquePatients);
          
          // Fetch message count for this doctor
          const { data: messagesData, error: messagesError } = await supabase
            .from('messages')
            .select('id')
            .eq('receiver_id', doctorId)
            .eq('is_read', false);
          
          if (!messagesError) {
            setMessageCount(messagesData?.length || 0);
          }
          
          // Calculate pending reviews (appointments that need follow-up)
          const pendingReviewsCount = appointmentsData?.filter((apt: any) => 
            apt.status === 'confirmed' && 
            new Date(apt.appointment_date) < new Date()
          ).length || 0;
          
          setPendingReviews(pendingReviewsCount);
        }
      } catch (error) {
        console.error('Error fetching doctor dashboard data:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [doctorId]);
  
  // Calculate stats based on real data
  const stats = [
    { 
      icon: Users, 
      label: 'Total Patients', 
      value: loading ? '-' : patients.length.toString(), 
      color: 'text-primary' 
    },
    { 
      icon: Calendar, 
      label: 'Today\'s Appointments', 
      value: loading ? '-' : appointments.filter((apt: any) => {
        const today = new Date().toISOString().split('T')[0];
        return apt.appointment_date && apt.appointment_date.includes(today);
      }).length.toString(),
      color: 'text-healthcare-green' 
    },
    { 
      icon: MessageCircle, 
      label: 'New Messages', 
      value: loading ? '-' : messageCount.toString(), 
      color: 'text-blue-500' 
    },
    { 
      icon: Clock, 
      label: 'Pending Reviews', 
      value: loading ? '-' : pendingReviews.toString(), 
      color: 'text-orange-500' 
    },
  ];

  return (
    <DashboardLayout userType="doctor">
      <div className="space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div>
            {loading ? (
              <>
                <Skeleton className="h-10 w-64 mb-2" />
                <Skeleton className="h-5 w-80" />
              </>
            ) : (
              <>
                <h1 className="text-3xl font-bold">
                  Good morning, {doctor?.name || 'Smith'}!
                </h1>
                <p className="text-muted-foreground">
                  You have {appointments.length} appointment{appointments.length !== 1 ? 's' : ''} scheduled
                </p>
              </>
            )}
          </div>
          <Button variant="healthcare" size="lg">
            <TrendingUp className="mr-2 h-4 w-4" />
            View Analytics
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
              <Card className="glass-card border-glass-border hover:shadow-glow-healthcare transition-smooth">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">{stat.label}</p>
                      {loading ? (
                        <Skeleton className="h-8 w-16" />
                      ) : (
                        <p className="text-3xl font-bold">{stat.value}</p>
                      )}
                    </div>
                    <stat.icon className={`h-8 w-8 ${stat.color}`} />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        {/* Today's Appointments */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="glass-card border-glass-border">
            <CardHeader>
              <CardTitle className="flex items-center">
                <Calendar className="mr-2 h-5 w-5" />
                Today's Schedule
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((_, index) => (
                    <div key={index} className="p-4 glass rounded-lg border border-glass-border">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-4">
                          <Skeleton className="h-10 w-10 rounded-full" />
                          <div>
                            <Skeleton className="h-5 w-32 mb-2" />
                            <Skeleton className="h-4 w-24" />
                          </div>
                        </div>
                        <div className="text-right">
                          <Skeleton className="h-5 w-16 mb-2" />
                          <Skeleton className="h-6 w-20" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : appointments.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  No appointments scheduled for today
                </div>
              ) : (
                <div className="space-y-4">
                  {appointments.filter((apt: any) => {
                    const today = new Date().toISOString().split('T')[0];
                    return apt.appointment_date && apt.appointment_date.includes(today);
                  }).map((appointment, index) => {
                    const patient = appointment.patient || {};
                    return (
                      <div
                        key={appointment.id || index}
                        className="flex items-center justify-between p-4 glass rounded-lg border border-glass-border"
                      >
                        <div className="flex items-center space-x-4">
                          <div className="p-2 rounded-full bg-gradient-healthcare">
                            <Users className="h-4 w-4 text-healthcare-green-foreground" />
                          </div>
                          <div>
                            <h4 className="font-semibold">{patient.name || 'Patient'}</h4>
                            <p className="text-sm text-muted-foreground">{appointment.appointment_type || 'Consultation'}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-medium">{appointment.appointment_time || '9:00 AM'}</p>
                          <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
                            appointment.status === 'confirmed' ? 'bg-healthcare-green/20 text-healthcare-green' :
                            appointment.status === 'pending' ? 'bg-orange-500/20 text-orange-500' :
                            'bg-red-500/20 text-red-500'
                          }`}>
                            {appointment.status || 'Pending'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Chat Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <Card className="glass border-glass-border">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-blue-500" />
                Recent Messages
              </CardTitle>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => navigate('/chat')}
                className="glass border-glass-border hover:bg-glass-hover"
              >
                View All Messages
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 glass rounded-lg border border-glass-border">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 rounded-full bg-blue-500/20">
                      <Users className="h-4 w-4 text-blue-500" />
                    </div>
                    <div>
                      <h4 className="font-medium">John Doe</h4>
                      <p className="text-sm text-muted-foreground">Thank you for the consultation...</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">2 min ago</p>
                    <span className="inline-block w-2 h-2 bg-blue-500 rounded-full"></span>
                  </div>
                </div>
                
                <div className="flex items-center justify-between p-3 glass rounded-lg border border-glass-border">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 rounded-full bg-green-500/20">
                      <Users className="h-4 w-4 text-green-500" />
                    </div>
                    <div>
                      <h4 className="font-medium">Sarah Wilson</h4>
                      <p className="text-sm text-muted-foreground">When is my next appointment?</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">5 min ago</p>
                  </div>
                </div>
                
                <div className="text-center py-2">
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={() => navigate('/chat')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Start New Conversation
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}