export type Json = 
   | string 
   | number 
   | boolean 
   | null 
   | { [key: string]: Json | undefined } 
   | Json[] 

// Export individual types for direct import
export type User = Database['public']['Tables']['users']['Row'];
export type Appointment = Database['public']['Tables']['appointments']['Row'];
export type Message = Database['public']['Tables']['messages']['Row'];
export type DoctorDetails = Database['public']['Tables']['doctor_details']['Row'];
export type AdminLog = Database['public']['Tables']['admin_logs']['Row'];
export type DoctorLog = Database['public']['Tables']['doctor_logs']['Row'];
 
export type Database = { 
  public: { 
    Tables: { 
      users: {
        Row: {
          id: number;
          name: string;
          email: string;
          password: string;
          role: 'user' | 'doctor' | 'admin';
          created_at: string;
        };
        Insert: {
          name: string;
          email: string;
          password: string;
          role: 'user' | 'doctor' | 'admin';
          created_at?: string;
          id?: number;
        };
        Update: {
          name?: string;
          email?: string;
          password?: string;
          role?: 'user' | 'doctor' | 'admin';
          created_at?: string;
        };
        Relationships: []
      };
      appointments: {
        Row: {
          id: number;
          user_id: number;
          doctor_id: number;
          status: string;
          created_at: string;
        };
        Insert: {
          user_id: number;
          doctor_id: number;
          status?: string;
          id?: number;
          created_at?: string;
        };
        Update: {
          user_id?: number;
          doctor_id?: number;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          }
        ]
      };
      messages: {
        Row: {
          id: number;
          sender_id: number;
          receiver_id: number;
          message: string;
          timestamp: string;
        };
        Insert: {
          sender_id: number;
          receiver_id: number;
          message: string;
          id?: number;
          timestamp?: string;
        };
        Update: {
          sender_id?: number;
          receiver_id?: number;
          message?: string;
          timestamp?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_receiver_id_fkey"
            columns: ["receiver_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          }
        ]
      };
      doctor_details: {
        Row: {
          id: number;
          user_id: number;
          specialization: string | null;
          qualification: string | null;
          experience: number | null;
          availability: string | null;
        };
        Insert: {
          user_id: number;
          specialization?: string | null;
          qualification?: string | null;
          experience?: number | null;
          availability?: string | null;
          id?: number;
        };
        Update: {
          user_id?: number;
          specialization?: string | null;
          qualification?: string | null;
          experience?: number | null;
          availability?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "doctor_details_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          }
        ]
      };
      admin_logs: {
        Row: {
          id: number;
          admin_id: number;
          timestamp: string;
        };
        Insert: {
          admin_id: number;
          id?: number;
          timestamp?: string;
        };
        Update: {
          admin_id?: number;
          timestamp?: string;
        };
        Relationships: [
          {
            foreignKeyName: "admin_logs_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          }
        ]
      };
      doctor_logs: {
        Row: {
          id: number;
          doctor_id: number;
          timestamp: string;
        };
        Insert: {
          doctor_id: number;
          id?: number;
          timestamp?: string;
        };
        Update: {
          doctor_id?: number;
          timestamp?: string;
        };
        Relationships: [
          {
            foreignKeyName: "doctor_logs_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          }
        ]
      };
    }
  }
};