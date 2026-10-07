import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client with actual configuration
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://legacy-project.invalid";
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "REDACTED_LEGACY_ANON_KEY";

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});

// User functions
export async function getUsers() {
  const { data, error } = await supabase.from('users').select('*');
  if (error) throw error;
  return data || [];
}

// Doctor functions
export async function getDoctors() {
  const { data, error } = await supabase.from('doctors').select('*');
  if (error) throw error;
  return data || [];
}

export async function getDoctorById(id: number) {
  const { data, error } = await supabase.from('doctors').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// Patient functions
export async function getPatients() {
  const { data, error } = await supabase.from('patients').select('*');
  if (error) throw error;
  return data || [];
}

// Appointment functions
export async function getAppointments() {
  const { data, error } = await supabase.from('appointments').select('*');
  if (error) throw error;
  return data || [];
}