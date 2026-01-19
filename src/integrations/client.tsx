import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const SUPABASE_URL = "https://wkiqqwmcagaegzgapjsl.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndraXFxd21jYWdhZWd6Z2FwanNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg2MTY2MDQsImV4cCI6MjA3NDE5MjYwNH0.DAk3UdPSwhcSjfIYI0iZVgPKs6VQhrnFNOfRK9PQzpw";

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
