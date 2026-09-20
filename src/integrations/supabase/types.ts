export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      currency_pairs: {
        Row: {
          active: boolean | null
          category: string | null
          created_at: string | null
          default_timeframe: string | null
          id: string
          name: string
          sort_order: number | null
          symbol: string
        }
        Insert: {
          active?: boolean | null
          category?: string | null
          created_at?: string | null
          default_timeframe?: string | null
          id?: string
          name: string
          sort_order?: number | null
          symbol: string
        }
        Update: {
          active?: boolean | null
          category?: string | null
          created_at?: string | null
          default_timeframe?: string | null
          id?: string
          name?: string
          sort_order?: number | null
          symbol?: string
        }
        Relationships: []
      }
      iqoption_connection_state: {
        Row: {
          login_blocked_reason: string | null
          login_blocked_until: string | null
          login_failures: number
          singleton: boolean
          ssid: string | null
          ssid_expires_at: string | null
          updated_at: string
        }
        Insert: {
          login_blocked_reason?: string | null
          login_blocked_until?: string | null
          login_failures?: number
          singleton?: boolean
          ssid?: string | null
          ssid_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          login_blocked_reason?: string | null
          login_blocked_until?: string | null
          login_failures?: number
          singleton?: boolean
          ssid?: string | null
          ssid_expires_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          full_name: string | null
          id: string
          plan: string | null
          timezone: string | null
          updated_at: string | null
          username: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          full_name?: string | null
          id: string
          plan?: string | null
          timezone?: string | null
          updated_at?: string | null
          username?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          full_name?: string | null
          id?: string
          plan?: string | null
          timezone?: string | null
          updated_at?: string | null
          username?: string | null
        }
        Relationships: []
      }
      signal_results: {
        Row: {
          exit_price: number | null
          id: string
          pips: number | null
          result: Database["public"]["Enums"]["signal_result_outcome"] | null
          signal_id: string | null
          verified_at: string | null
        }
        Insert: {
          exit_price?: number | null
          id?: string
          pips?: number | null
          result?: Database["public"]["Enums"]["signal_result_outcome"] | null
          signal_id?: string | null
          verified_at?: string | null
        }
        Update: {
          exit_price?: number | null
          id?: string
          pips?: number | null
          result?: Database["public"]["Enums"]["signal_result_outcome"] | null
          signal_id?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signal_results_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      signals: {
        Row: {
          analysis_summary: string | null
          confidence: number | null
          created_at: string | null
          direction: Database["public"]["Enums"]["signal_direction"]
          entry_price: number | null
          expiration_minutes: number | null
          expired_at: string | null
          id: string
          pair_id: string | null
          resulted_at: string | null
          status: Database["public"]["Enums"]["signal_status"] | null
          timeframe: string | null
        }
        Insert: {
          analysis_summary?: string | null
          confidence?: number | null
          created_at?: string | null
          direction: Database["public"]["Enums"]["signal_direction"]
          entry_price?: number | null
          expiration_minutes?: number | null
          expired_at?: string | null
          id?: string
          pair_id?: string | null
          resulted_at?: string | null
          status?: Database["public"]["Enums"]["signal_status"] | null
          timeframe?: string | null
        }
        Update: {
          analysis_summary?: string | null
          confidence?: number | null
          created_at?: string | null
          direction?: Database["public"]["Enums"]["signal_direction"]
          entry_price?: number | null
          expiration_minutes?: number | null
          expired_at?: string | null
          id?: string
          pair_id?: string | null
          resulted_at?: string | null
          status?: Database["public"]["Enums"]["signal_status"] | null
          timeframe?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signals_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "currency_pairs"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          plan: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["subscription_status"] | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          plan?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["subscription_status"] | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          plan?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["subscription_status"] | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_favorites: {
        Row: {
          created_at: string | null
          id: string
          pair_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          pair_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          pair_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_favorites_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "currency_pairs"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          created_at: string | null
          default_expiration: number | null
          email_notifications: boolean | null
          id: string
          push_notifications: boolean | null
          risk_per_trade: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          default_expiration?: number | null
          email_notifications?: boolean | null
          id: string
          push_notifications?: boolean | null
          risk_per_trade?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          default_expiration?: number | null
          email_notifications?: boolean | null
          id?: string
          push_notifications?: boolean | null
          risk_per_trade?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_iqoption_login: {
        Args: { claim_for_seconds?: number }
        Returns: {
          claimed: boolean
          login_blocked_reason: string
          login_blocked_until: string
          login_failures: number
          ssid: string
          ssid_expires_at: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      signal_direction: "CALL" | "PUT"
      signal_result_outcome: "win" | "loss" | "draw"
      signal_status: "active" | "expired" | "won" | "lost"
      subscription_status: "active" | "canceled" | "past_due" | "expired"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      signal_direction: ["CALL", "PUT"],
      signal_result_outcome: ["win", "loss", "draw"],
      signal_status: ["active", "expired", "won", "lost"],
      subscription_status: ["active", "canceled", "past_due", "expired"],
    },
  },
} as const
