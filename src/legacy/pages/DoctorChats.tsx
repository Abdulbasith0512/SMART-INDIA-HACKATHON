import { motion } from 'framer-motion';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { MessageCircle, Search, Users, Clock, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getPatients } from '@/lib/supabase';
import { supabase } from '@/integrations/client';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import type { Message as DatabaseMessage, User as DatabaseUser } from '@/integrations/types';

export default function DoctorChats() {
  const [patients, setPatients] = useState<any[]>([]);
  const [selectedContact, setSelectedContact] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const location = useLocation();
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
          // Extract unique patients from appointments
          const uniquePatients = appointmentsData?.reduce((acc: any[], appointment: any) => {
            if (appointment.patient && !acc.find(p => p.id === appointment.patient.id)) {
              acc.push(appointment.patient);
            }
            return acc;
          }, []) || [];
          
          setPatients(uniquePatients);
        }
        
        // Check if a contact was passed from navigation
        if (location.state?.selectedContact) {
          setSelectedContact(location.state.selectedContact);
        }
      } catch (error) {
        console.error('Error fetching patients data:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [location.state, doctorId]);
  
  // Fetch messages between doctor and selected patient
  const fetchMessages = async (patientId: number) => {
    try {
      const { data: messagesData, error } = await supabase
        .from('messages')
        .select(`
          *,
          sender:users!messages_sender_id_fkey(id, name),
          receiver:users!messages_receiver_id_fkey(id, name)
        `)
        .or(`and(sender_id.eq.${doctorId},receiver_id.eq.${patientId}),and(sender_id.eq.${patientId},receiver_id.eq.${doctorId})`)
        .order('timestamp', { ascending: true });

      if (error) {
        console.error('Error fetching messages:', error);
        return [];
      }

      return messagesData || [];
    } catch (error) {
      console.error('Error fetching messages:', error);
      return [];
    }
  };

  // Fetch messages when a contact is selected
  useEffect(() => {
    if (selectedContact) {
      const loadMessages = async () => {
        const messagesData = await fetchMessages(selectedContact.id);
        setMessages(messagesData);
      };
      loadMessages();
    } else {
      setMessages([]);
    }
  }, [selectedContact]);

  // Filter patients based on search term
  const filteredPatients = patients.filter(patient => {
    const fullName = (patient.name || '').toLowerCase();
    const email = (patient.email || '').toLowerCase();
    return fullName.includes(searchTerm.toLowerCase()) || email.includes(searchTerm.toLowerCase());
  });
  const handleSendMessage = async () => {
    if (newMessage.trim() && selectedContact) {
      try {
        // Send message to database
        const { error } = await supabase
          .from('messages')
          .insert({
            sender_id: doctorId,
            receiver_id: selectedContact.id,
            message: newMessage.trim(),
            timestamp: new Date().toISOString()
          });

        if (error) {
          console.error('Error sending message:', error);
        } else {
          // Refresh messages after sending
          const updatedMessages = await fetchMessages(selectedContact.id);
          setMessages(updatedMessages);
          setNewMessage('');
        }
      } catch (error) {
        console.error('Error sending message:', error);
      }
    }
  };

  return (
    <DashboardLayout userType="doctor">
      <div className="space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div>
            <h1 className="text-3xl font-bold">Patient Messages</h1>
            <p className="text-muted-foreground">
              Communicate with your patients securely
            </p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]"
        >
          {/* Contacts List */}
          <Card className="glass-card border-glass-border">
            <CardHeader>
              <CardTitle className="flex items-center">
                <Users className="mr-2 h-5 w-5" />
                Patients
              </CardTitle>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  placeholder="Search patients..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[450px] overflow-y-auto">
                {loading ? (
                  <div className="space-y-2 p-4">
                    {[1, 2, 3, 4, 5].map((_, index) => (
                      <div key={index} className="flex items-center space-x-3 p-3">
                        <Skeleton className="h-10 w-10 rounded-full" />
                        <div className="flex-1">
                          <Skeleton className="h-4 w-24 mb-1" />
                          <Skeleton className="h-3 w-32" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : filteredPatients.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {searchTerm ? 'No patients found.' : 'No patients available.'}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredPatients.map((patient, index) => (
                      <motion.div
                        key={patient.id || index}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className={`flex items-center space-x-3 p-4 cursor-pointer hover:bg-glass/50 transition-smooth ${
                          selectedContact?.id === patient.id ? 'bg-primary/10 border-r-2 border-primary' : ''
                        }`}
                        onClick={() => setSelectedContact(patient)}
                      >
                        <div className="p-2 rounded-full bg-gradient-healthcare">
                          <Users className="h-4 w-4 text-healthcare-green-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium truncate">
                            {patient.name || 'Patient'}
                          </h4>
                          <p className="text-sm text-muted-foreground truncate">
                            Last message: 2 hours ago
                          </p>
                        </div>
                        <div className="flex flex-col items-end">
                          <span className="text-xs text-muted-foreground">10:37 AM</span>
                          <Badge variant="secondary" className="text-xs mt-1">
                            2
                          </Badge>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Chat Window */}
          <Card className="lg:col-span-2 glass-card border-glass-border flex flex-col">
            {selectedContact ? (
              <>
                <CardHeader className="border-b border-glass-border">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 rounded-full bg-gradient-healthcare">
                      <Users className="h-5 w-5 text-healthcare-green-foreground" />
                    </div>
                    <div>
                      <h3 className="font-semibold">
                        {selectedContact.name || 'Patient'}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {selectedContact.email || 'No email provided'}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                
                <CardContent className="flex-1 p-4 overflow-y-auto">
                  <div className="space-y-4">
                    {messages.length === 0 ? (
                      <div className="text-center text-muted-foreground py-8">
                        <MessageCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>No messages yet. Start a conversation!</p>
                      </div>
                    ) : (
                      messages.map((msg) => {
                        const isFromDoctor = msg.sender_id === doctorId;
                        return (
                          <div
                            key={msg.id}
                            className={`flex ${isFromDoctor ? 'justify-end' : 'justify-start'}`}
                          >
                            <div
                              className={`max-w-[70%] p-3 rounded-lg ${
                                isFromDoctor
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-glass border border-glass-border'
                              }`}
                            >
                              <p className="text-sm">{msg.message}</p>
                              <div className="flex items-center justify-between mt-2">
                                <span className="text-xs opacity-70">
                                  {new Date(msg.timestamp).toLocaleTimeString([], { 
                                    hour: '2-digit', 
                                    minute: '2-digit' 
                                  })}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </CardContent>
                
                <div className="p-4 border-t border-glass-border">
                  <div className="flex space-x-2">
                    <Input
                      placeholder="Type your message..."
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                      className="flex-1"
                    />
                    <Button 
                      onClick={handleSendMessage}
                      disabled={!newMessage.trim()}
                      className="px-4"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <CardContent className="flex-1 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <MessageCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <h3 className="text-lg font-medium mb-2">Select a Patient</h3>
                  <p>Choose a patient from the list to start messaging</p>
                </div>
              </CardContent>
            )}
          </Card>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}