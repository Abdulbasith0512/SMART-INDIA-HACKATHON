import { supabase } from '@/integrations/client';

// Test users to insert into the database
const testUsers = [
  {
    name: "Dr. Rakesh Kumar",
    email: "rakesh.k@gmail.com",
    password: "password123",
    role: "doctor" as const
  },
  {
    name: "Dr. Sarah Johnson",
    email: "sarah.johnson@gmail.com", 
    password: "password123",
    role: "doctor" as const
  },
  {
    name: "John Smith",
    email: "john.smith@gmail.com",
    password: "password123", 
    role: "user" as const
  },
  {
    name: "Admin User",
    email: "admin@gmail.com",
    password: "password123",
    role: "admin" as const
  }
];

export async function insertTestUsers() {
  try {
    console.log('Inserting test users...');
    
    for (const user of testUsers) {
      // Check if user already exists
      const { data: existingUser } = await supabase
        .from('users')
        .select('email')
        .eq('email', user.email)
        .single();
        
      if (!existingUser) {
        const { data, error } = await supabase
          .from('users')
          .insert([user])
          .select();
          
        if (error) {
          console.error(`Error inserting user ${user.email}:`, error);
        } else {
          console.log(`Successfully inserted user: ${user.email}`);
        }
      } else {
        console.log(`User ${user.email} already exists`);
      }
    }
    
    console.log('Test users insertion completed');
  } catch (error) {
    console.error('Error inserting test users:', error);
  }
}

// Run the function if this script is executed directly
if (typeof window !== 'undefined') {
  insertTestUsers();
}