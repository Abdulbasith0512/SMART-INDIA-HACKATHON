import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client with actual configuration
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://wkiqqwmcagaegzgapjsl.supabase.co";
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndraXFxd21jYWdhZWd6Z2FwanNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg2MTY2MDQsImV4cCI6MjA3NDE5MjYwNH0.DAk3UdPSwhcSjfIYI0iZVgPKs6VQhrnFNOfRK9PQzpw";

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