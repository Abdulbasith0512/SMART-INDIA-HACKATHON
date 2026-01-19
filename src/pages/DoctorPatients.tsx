import { motion } from 'framer-motion';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Users, Search, MessageCircle, Calendar, Phone, Mail, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getAppointments, getPatients } from '@/lib/supabase';
import { supabase } from '@/integrations/client';
import { Skeleton } from '@/components/ui/skeleton';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import type { User as DatabaseUser } from '@/integrations/types';

export default function DoctorPatients() {
  const [patients, setPatients] = useState<any[]>([]);
  const [appointments, setAppointments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();
  
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Wait for authentication to complete
        if (authLoading) {
          return;
        }
        
        // Check if user is authenticated and is a doctor
        if (!user || !user.email || user.role !== 'doctor') {
          navigate('/login');
          return;
        }
        
        // Use the authenticated user's ID directly (no need for additional database query)
        const currentDoctorId = user.id;
        setDoctorId(currentDoctorId);
        
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
          .eq('doctor_id', currentDoctorId);
        
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
        }
      } catch (error) {
        console.error('Error fetching patients data:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [user, navigate, authLoading]);
  
  // Filter patients based on search term
  const filteredPatients = patients.filter(patient => {
    const name = (patient.name || '').toLowerCase();
    const email = (patient.email || '').toLowerCase();
    return name.includes(searchTerm.toLowerCase()) || email.includes(searchTerm.toLowerCase());
  });
  
  // Get patient's appointment history with this doctor
  const getPatientAppointments = (patientId: number) => {
    return appointments.filter(apt => apt.user_id === patientId);
  };

  // Show loading while authentication is in progress
  if (authLoading) {
    return (
      <DashboardLayout userType="doctor">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
            <p>Loading...</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout userType="doctor">
      <div className="space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div>
            <h1 className="text-3xl font-bold">My Patients</h1>
            <p className="text-muted-foreground">
              Manage and view your patient information
            </p>
          </div>
          <div className="flex items-center space-x-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search patients..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 w-64"
              />
            </div>
          </div>
        </motion.div>

        {/* Stats Cards */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6"
        >
          <Card className="glass-card border-glass-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Patients</p>
                  <p className="text-3xl font-bold">{loading ? '-' : patients.length}</p>
                </div>
                <Users className="h-8 w-8 text-primary" />
              </div>
            </CardContent>
          </Card>
          
          <Card className="glass-card border-glass-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Appointments</p>
                  <p className="text-3xl font-bold">{loading ? '-' : appointments.filter(apt => apt.status === 'confirmed').length}</p>
                </div>
                <Calendar className="h-8 w-8 text-healthcare-green" />
              </div>
            </CardContent>
          </Card>
          
          <Card className="glass-card border-glass-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">New This Month</p>
                  <p className="text-3xl font-bold">{loading ? '-' : appointments.filter(apt => {
                    const currentMonth = new Date().getMonth();
                    const currentYear = new Date().getFullYear();
                    const aptDate = new Date(apt.created_at);
                    return aptDate.getMonth() === currentMonth && aptDate.getFullYear() === currentYear;
                  }).length}</p>
                </div>
                <TrendingUp className="h-8 w-8 text-blue-500" />
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Patients List */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="glass-card border-glass-border">
            <CardHeader>
              <CardTitle className="flex items-center">
                <Users className="mr-2 h-5 w-5" />
                Patient Directory
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5].map((_, index) => (
                    <div key={index} className="p-4 glass rounded-lg border border-glass-border">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-4">
                          <Skeleton className="h-12 w-12 rounded-full" />
                          <div>
                            <Skeleton className="h-5 w-32 mb-2" />
                            <Skeleton className="h-4 w-48" />
                          </div>
                        </div>
                        <div className="flex space-x-2">
                          <Skeleton className="h-8 w-20" />
                          <Skeleton className="h-8 w-20" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredPatients.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {searchTerm ? 'No patients found matching your search.' : 'No patients found.'}
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredPatients.map((patient, index) => {
                    const patientAppointments = getPatientAppointments(patient.id);
                    const lastAppointment = patientAppointments[patientAppointments.length - 1];
                    
                    return (
                      <motion.div
                        key={patient.id || index}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className="p-4 glass rounded-lg border border-glass-border hover:shadow-glow-healthcare transition-smooth"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div className="p-3 rounded-full bg-gradient-healthcare">
                              <Users className="h-6 w-6 text-healthcare-green-foreground" />
                            </div>
                            <div>
                              <h4 className="font-semibold text-lg">
                                {patient.name || 'Patient'}
                              </h4>
                              <p className="text-sm text-muted-foreground flex items-center">
                                <Mail className="h-3 w-3 mr-1" />
                                {patient.email || 'No email provided'}
                              </p>
                              {lastAppointment && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  Last visit: {lastAppointment.appointment_date || 'N/A'}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <Badge variant="outline" className="text-xs">
                              {patientAppointments.length} appointment{patientAppointments.length !== 1 ? 's' : ''}
                            </Badge>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => navigate('/doctor-dashboard/chats', { 
                                state: { selectedContact: patient } 
                              })}
                              className="glass border-glass-border hover:bg-glass-hover"
                            >
                              <MessageCircle className="h-4 w-4 mr-1" />
                              Message
                            </Button>
                            <Button
                              variant="healthcare"
                              size="sm"
                              onClick={() => navigate('/book-appointment', { 
                                state: { 
                                  patientId: patient.id,
                                  patientName: patient.name,
                                  doctorId: doctorId
                                } 
                              })}
                            >
                              <Calendar className="h-4 w-4 mr-1" />
                              Schedule
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}