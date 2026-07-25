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
      branches: {
        Row: {
          branch_no: string
          city: string
          created_at: string
        }
        Insert: {
          branch_no: string
          city: string
          created_at?: string
        }
        Update: {
          branch_no?: string
          city?: string
          created_at?: string
        }
        Relationships: []
      }
      cdr_progress: {
        Row: {
          error: string | null
          job_id: string
          message: string
          page: number
          records: number
          status: string
          total_pages: number | null
          total_reported: number | null
          updated_at: string
        }
        Insert: {
          error?: string | null
          job_id: string
          message?: string
          page?: number
          records?: number
          status?: string
          total_pages?: number | null
          total_reported?: number | null
          updated_at?: string
        }
        Update: {
          error?: string | null
          job_id?: string
          message?: string
          page?: number
          records?: number
          status?: string
          total_pages?: number | null
          total_reported?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      complaint_activity: {
        Row: {
          action: string
          actor_id: string | null
          complaint_id: string
          created_at: string
          details: Json
          id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          complaint_id: string
          created_at?: string
          details?: Json
          id?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          complaint_id?: string
          created_at?: string
          details?: Json
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "complaint_activity_complaint_id_fkey"
            columns: ["complaint_id"]
            isOneToOne: false
            referencedRelation: "complaints"
            referencedColumns: ["id"]
          },
        ]
      }
      complaints: {
        Row: {
          agent_id: string
          branch_no: string | null
          category: string | null
          complaint_date: string
          created_at: string
          customer_name: string | null
          customer_phone: string | null
          description: string | null
          display_no: string
          id: string
          resolution: string | null
          status: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          branch_no?: string | null
          category?: string | null
          complaint_date?: string
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          description?: string | null
          display_no?: string
          id?: string
          resolution?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          branch_no?: string | null
          category?: string | null
          complaint_date?: string
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          description?: string | null
          display_no?: string
          id?: string
          resolution?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          kind: string
          link: string | null
          read_at: string | null
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind: string
          link?: string | null
          read_at?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind?: string
          link?: string | null
          read_at?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      order_activity: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json
          id: string
          order_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          order_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_activity_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          agent_id: string
          branch_no: string | null
          call_center_verified: boolean
          created_at: string
          customer_name: string | null
          customer_phone: string | null
          delivery_type: string | null
          display_no: string
          id: string
          invoice_no: string | null
          invoice_value: number | null
          notes: string | null
          order_date: string
          order_type: string
          status: string
          team: Database["public"]["Enums"]["app_role"]
          updated_at: string
        }
        Insert: {
          agent_id: string
          branch_no?: string | null
          call_center_verified?: boolean
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          delivery_type?: string | null
          display_no?: string
          id?: string
          invoice_no?: string | null
          invoice_value?: number | null
          notes?: string | null
          order_date?: string
          order_type: string
          status?: string
          team: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Update: {
          agent_id?: string
          branch_no?: string | null
          call_center_verified?: boolean
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          delivery_type?: string | null
          display_no?: string
          id?: string
          invoice_no?: string | null
          invoice_value?: number | null
          notes?: string | null
          order_date?: string
          order_type?: string
          status?: string
          team?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_branch_no_fkey"
            columns: ["branch_no"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["branch_no"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          agent_code: string | null
          avatar_url: string | null
          created_at: string
          full_name: string
          id: string
          permissions: string[]
          updated_at: string
          yeastar_ext: string | null
        }
        Insert: {
          active?: boolean
          agent_code?: string | null
          avatar_url?: string | null
          created_at?: string
          full_name: string
          id: string
          permissions?: string[]
          updated_at?: string
          yeastar_ext?: string | null
        }
        Update: {
          active?: boolean
          agent_code?: string | null
          avatar_url?: string | null
          created_at?: string
          full_name?: string
          id?: string
          permissions?: string[]
          updated_at?: string
          yeastar_ext?: string | null
        }
        Relationships: []
      }
      satisfaction_surveys: {
        Row: {
          agent_id: string | null
          call_id: string | null
          comment: string | null
          created_at: string
          id: string
          rating: number
          submitted_at: string
        }
        Insert: {
          agent_id?: string | null
          call_id?: string | null
          comment?: string | null
          created_at?: string
          id?: string
          rating: number
          submitted_at?: string
        }
        Update: {
          agent_id?: string | null
          call_id?: string | null
          comment?: string | null
          created_at?: string
          id?: string
          rating?: number
          submitted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "satisfaction_surveys_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      yeastar_extension_map: {
        Row: {
          active: boolean
          agent_code: string | null
          agent_name: string
          created_at: string
          ext_num: string
          team: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          agent_code?: string | null
          agent_name: string
          created_at?: string
          ext_num: string
          team: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          agent_code?: string | null
          agent_name?: string
          created_at?: string
          ext_num?: string
          team?: string
          updated_at?: string
        }
        Relationships: []
      }
      yeastar_token_cache: {
        Row: {
          access_expires_at: string | null
          access_token: string | null
          block_reason: string | null
          blocked_until: string | null
          id: number
          obtained_at: string | null
          refresh_expires_at: string | null
          refresh_token: string | null
          updated_at: string | null
        }
        Insert: {
          access_expires_at?: string | null
          access_token?: string | null
          block_reason?: string | null
          blocked_until?: string | null
          id?: number
          obtained_at?: string | null
          refresh_expires_at?: string | null
          refresh_token?: string | null
          updated_at?: string | null
        }
        Update: {
          access_expires_at?: string | null
          access_token?: string | null
          block_reason?: string | null
          blocked_until?: string | null
          id?: number
          obtained_at?: string | null
          refresh_expires_at?: string | null
          refresh_token?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      complaints_in_scope: {
        Args: { _agent?: string; _from: string; _mine?: boolean; _to: string }
        Returns: {
          agent_id: string
          branch_no: string | null
          category: string | null
          complaint_date: string
          created_at: string
          customer_name: string | null
          customer_phone: string | null
          description: string | null
          display_no: string
          id: string
          resolution: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "complaints"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complaints_kpis: {
        Args: { _agent?: string; _from: string; _mine?: boolean; _to: string }
        Returns: {
          in_progress: number
          resolution_rate: number
          resolved: number
          total: number
        }[]
      }
      complaints_locations: {
        Args: { _agent?: string; _from: string; _mine?: boolean; _to: string }
        Returns: {
          location: string
          location_type: string
          open: number
          rate: number
          resolved: number
          total: number
        }[]
      }
      get_my_profile: {
        Args: never
        Returns: {
          active: boolean
          agent_code: string | null
          avatar_url: string | null
          created_at: string
          full_name: string
          id: string
          permissions: string[]
          updated_at: string
          yeastar_ext: string | null
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      has_permission: {
        Args: { _permission: string; _user_id: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_active: { Args: { _user_id: string }; Returns: boolean }
      is_administrator: { Args: { _user_id: string }; Returns: boolean }
      notify_users: {
        Args: {
          _body: string
          _entity_id: string
          _entity_type: string
          _kind: string
          _link: string
          _title: string
          _user_ids: string[]
        }
        Returns: undefined
      }
      orders_agents: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          agent_id: string
          agent_name: string
          completed_sales: number
          completion_rate: number
          order_count: number
          team: string
        }[]
      }
      orders_daily: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          completed_sales: number
          day: string
          total_sales: number
        }[]
      }
      orders_delivery: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          completed_sales: number
          completion_rate: number
          delivery_type: string
          order_count: number
        }[]
      }
      orders_delivery_matrix: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          completed_sales: number
          delivery_type: string
          location: string
          location_type: string
        }[]
      }
      orders_in_scope: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          agent_id: string
          branch_no: string | null
          call_center_verified: boolean
          created_at: string
          customer_name: string | null
          customer_phone: string | null
          delivery_type: string | null
          display_no: string
          id: string
          invoice_no: string | null
          invoice_value: number | null
          notes: string | null
          order_date: string
          order_type: string
          status: string
          team: Database["public"]["Enums"]["app_role"]
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      orders_kpi_summary: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _q?: string
          _status?: string
          _team?: string
          _to: string
        }
        Returns: Json
      }
      orders_kpis: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          bucket: string
          cancelled_count: number
          completed_count: number
          completed_sales: number
          completion_rate: number
          order_count: number
          pending_count: number
          total_sales: number
        }[]
      }
      orders_locations: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          completed_count: number
          completed_sales: number
          completion_rate: number
          location: string
          location_type: string
          order_count: number
          total_sales: number
        }[]
      }
      orders_status: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          order_count: number
          status: string
        }[]
      }
      orders_teams: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          completed_sales: number
          completion_rate: number
          order_count: number
          team: string
        }[]
      }
      orders_verification: {
        Args: {
          _agent?: string
          _from: string
          _mine?: boolean
          _team?: string
          _to: string
        }
        Returns: {
          agent_id: string
          agent_name: string
          non_verified: number
          rate: number
          total_orders: number
          verified: number
          verified_value: number
        }[]
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "customer_care"
        | "telesales"
        | "auditor"
        | "owner"
        | "call_center"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: [
        "admin",
        "customer_care",
        "telesales",
        "auditor",
        "owner",
        "call_center",
      ],
    },
  },
} as const
