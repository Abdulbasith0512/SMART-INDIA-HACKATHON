import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { MoreVertical } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/client';
import { ChatWindow } from '@/components/chat/ChatWindow';

// Local function implementations since they're not available in client.tsx
const getAppointmentsWithDoctorsByUserId = async (userId: number): Promise<AppointmentWithDoctor[] | null> => {
  const { data, error } = await supabase
    .from('appointments')
    .select(`
      *,
      doctor:users!appointments_doctor_id_fkey (
        id,
        name,
        email,
        doctor_details (
          specialization,
          qualification,
          experience
        )
      )
    `)
    .eq('user_id', userId);
  
  if (error) {
    console.error('Error fetching appointments:', error);
    return null;
  }
  return data as AppointmentWithDoctor[] | null;
};

const getUserById = async (userId: number): Promise<any> => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching user:', error);
    return null;
  }

  return data;
};

const getMessagesBetweenUsers = async (userId1: number, userId2: number) => {
  const { data, error } = await supabase
    .from('messages')
    .select(`
      *,
      sender:users!messages_sender_id_fkey (id, name),
      receiver:users!messages_receiver_id_fkey (id, name)
    `)
    .or(`and(sender_id.eq.${userId1},receiver_id.eq.${userId2}),and(sender_id.eq.${userId2},receiver_id.eq.${userId1})`)
    .order('timestamp', { ascending: true });
  
  if (error) {
    console.error('Error fetching messages:', error);
    return [];
  }
  return data;
};

const sendMessageToDb = async (senderId: number, receiverId: number, message: string): Promise<Message | null> => {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      sender_id: senderId,
      receiver_id: receiverId,
      message: message,
      timestamp: new Date().toISOString()
    })
    .select()
    .maybeSingle();
  
  if (error) {
    console.error('Error sending message:', error);
    return null;
  }
  return data as Message | null;
};

const getLastMessageBetweenUsers = async (userId1: number, userId2: number): Promise<Message | null> => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`and(sender_id.eq.${userId1},receiver_id.eq.${userId2}),and(sender_id.eq.${userId2},receiver_id.eq.${userId1})`)
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  
  if (error) {
    console.error('Error fetching last message:', error);
    return null;
  }
  
  return data as Message | null;
};

interface Message {
  id: number;
  sender_id: number;
  receiver_id: number;
  message: string;
  timestamp: string;
  sender?: { id: number; name: string };
  receiver?: { id: number; name: string };
}

interface Contact {
  id: number;
  name: string;
  specialty: string;
  online: boolean;
  lastMessage: string;
  time: string;
}

interface AppointmentWithDoctor {
  id: number;
  user_id: number;
  doctor_id: number;
  doctor: {
    id: number;
    name: string;
    email: string;
    doctor_details: Array<{
      specialization: string;
      qualification: string;
      experience: string;
    }>;
  } | null;
}

export default function ChatInterface() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);

  useEffect(() => {
    const fetchUserAndAppointments = async () => {
      if (!user?.email) {
        setLoading(false);
        return;
      }

      try {
        // First, get the current user's ID from the database
        const userResult = await supabase
          .from('users')
          .select('id')
          .eq('email', user.email)
          .maybeSingle();
        
        const userData = userResult.data as { id: number } | null;
        const error = userResult.error;

        if (userData && !error && userData.id) {
          setCurrentUserId(userData.id);
          
          // Then get appointments with doctor details
          const appointmentsData = await getAppointmentsWithDoctorsByUserId(userData.id);
          
          if (appointmentsData && appointmentsData.length > 0) {
            // Transform appointments data into contacts
            const doctorContactsPromises = appointmentsData.map(async (appointment: AppointmentWithDoctor): Promise<Contact | null> => {
              // Check if doctor exists and has an id
              if (!appointment.doctor || !appointment.doctor.id) {
                return null;
              }
              
              // Get last message between user and doctor
              const lastMessage = await getLastMessageBetweenUsers(userData.id, appointment.doctor.id);
              
              return {
                id: appointment.doctor.id,
                name: appointment.doctor.name || 'Unknown Doctor',
                specialty: appointment.doctor.doctor_details?.[0]?.specialization || 'General Medicine',
                online: Math.random() > 0.5, // Simulate online status
                lastMessage: lastMessage?.message || 'No messages yet',
                time: lastMessage && lastMessage.timestamp ? new Date(lastMessage.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Start chat'
              } as Contact;
            });

            const doctorContactsResults = await Promise.all(doctorContactsPromises);
            const doctorContacts = doctorContactsResults.filter((contact): contact is Contact => contact !== null);

            // Remove duplicates (same doctor with multiple appointments)
            const uniqueContacts = doctorContacts.filter((contact, index, self) => 
              index === self.findIndex(c => c.id === contact.id)
            );

            setContacts(uniqueContacts);
            if (uniqueContacts.length > 0) {
              setSelectedContact(uniqueContacts[0]);
            }
          }
        }
      } catch (error) {
        console.error('Error fetching appointments:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUserAndAppointments();
  }, [user]);

  // Load messages when selectedContact changes
  useEffect(() => {
    if (selectedContact && currentUserId) {
      loadMessages(selectedContact.id);
    }
  }, [selectedContact, currentUserId]);

  // Real-time message subscription
  useEffect(() => {
    if (!currentUserId || !selectedContact) return;

    const channel = supabase
      .channel('messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `or(and(sender_id.eq.${currentUserId},receiver_id.eq.${selectedContact.id}),and(sender_id.eq.${selectedContact.id},receiver_id.eq.${currentUserId}))`
        },
        (payload) => {
          // Add the new message to the current messages
          const newMessage = payload.new as Message;
          setMessages(prev => [...prev, newMessage]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId, selectedContact]);

  // Load messages when a contact is selected
  const loadMessages = async (contactId: number) => {
    if (!currentUserId) return;
    
    setMessagesLoading(true);
    try {
      const messagesData = await getMessagesBetweenUsers(currentUserId, contactId);
      setMessages(messagesData || []);
    } catch (error) {
      console.error('Error loading messages:', error);
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  };

  // Handle contact selection
  const handleContactSelect = (contact: Contact) => {
    setSelectedContact(contact);
    loadMessages(contact.id);
  };

  const handleSendMessage = async (message: string) => {
    if (!message.trim() || !selectedContact || !currentUserId) return;

    try {
      // Send message to database
      await sendMessageToDb(currentUserId, selectedContact.id, message);
      
      // Reload messages to show the new message
      await loadMessages(selectedContact.id);
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  return (
    <DashboardLayout userType="user">
      <div className="h-[calc(100vh-8rem)]">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-full">
          {/* Contacts Sidebar */}
          <Card className="glass-card border-glass-border lg:col-span-1">
            <CardHeader>
              <CardTitle>Messages</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[500px]">
                {loading ? (
                  <div className="p-4 text-center text-muted-foreground">
                    Loading your conversations...
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground">
                    <p>No conversations yet.</p>
                    <p className="text-xs mt-2">Book an appointment with a doctor to start chatting!</p>
                  </div>
                ) : (
                  contacts.map((contact) => (
                    <div
                      key={contact.id}
                      onClick={() => handleContactSelect(contact)}
                      className={`p-4 cursor-pointer border-b border-glass-border hover:bg-glass/50 transition-smooth ${
                        selectedContact?.id === contact.id ? 'bg-primary/10' : ''
                      }`}
                    >
                      <div className="flex items-center space-x-3">
                        <div className="relative">
                          <Avatar>
                            <AvatarFallback className="bg-gradient-primary text-primary-foreground">
                              {contact.name.split(' ').map(n => n[0]).join('')}
                            </AvatarFallback>
                          </Avatar>
                          {contact.online && (
                            <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-healthcare-green rounded-full border-2 border-background"></div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm truncate">{contact.name}</h4>
                          <p className="text-xs text-muted-foreground">{contact.specialty}</p>
                          <p className="text-xs text-muted-foreground truncate mt-1">{contact.lastMessage}</p>
                        </div>
                        <span className="text-xs text-muted-foreground">{contact.time}</span>
                      </div>
                    </div>
                  ))
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Chat Interface */}
          <Card className="glass-card border-glass-border lg:col-span-3 flex flex-col">
            {selectedContact ? (
              <>
                {/* Chat Header */}
                <CardHeader className="border-b border-glass-border">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <Avatar>
                        <AvatarFallback className="bg-gradient-healthcare text-healthcare-green-foreground">
                          {selectedContact.name.split(' ').map(n => n[0]).join('')}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <h3 className="font-semibold">{selectedContact.name}</h3>
                        <p className="text-sm text-muted-foreground">{selectedContact.specialty}</p>
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      <Button variant="ghost" size="icon" className="glass">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                {/* Chat Window */}
                <div className="flex-1 flex flex-col h-[500px]">
                  <ChatWindow
                    messages={messages}
                    currentUserId={currentUserId || 0}
                    onSendMessage={handleSendMessage}
                    isLoading={messagesLoading}
                  />
                </div>
              </>
            ) : (
              <CardContent className="flex-1 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <p>Select a conversation to start chatting</p>
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}