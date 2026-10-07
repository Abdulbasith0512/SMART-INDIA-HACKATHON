// Hand-written to match supabase/migrations. Regenerate with:
//   npx supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type AppRole = "citizen" | "clinician" | "officer" | "admin";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          preferred_language: string;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: { display_name?: string | null; preferred_language?: string };
        Relationships: [];
      };
      user_roles: {
        Row: {
          id: string;
          user_id: string;
          role: AppRole;
          region_id: string | null;
          granted_by: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: number;
          actor_id: string | null;
          action: string;
          entity: string;
          entity_id: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      has_role: { Args: { _user_id: string; _role: AppRole }; Returns: boolean };
      admin_set_user_role: {
        Args: { _target: string; _role: AppRole; _grant: boolean };
        Returns: undefined;
      };
      admin_list_users: {
        Args: { _limit?: number; _offset?: number };
        Returns: {
          user_id: string;
          email: string;
          display_name: string | null;
          roles: AppRole[];
          created_at: string;
        }[];
      };
    };
    Enums: { app_role: AppRole };
    CompositeTypes: { [_ in never]: never };
  };
};
