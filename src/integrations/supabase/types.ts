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
      admin_activity: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json
          id: string
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          target_user_id?: string | null
        }
        Relationships: []
      }
      alshrouq_dispatches: {
        Row: {
          alshrouq_branch_id: string
          attempt_count: number
          branch_no: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_order_id: string
          created_at: string
          crm_agent_id: string | null
          customer_address: string | null
          customer_lat: number | null
          customer_lng: number | null
          details: string | null
          dispatch_status: string
          dispatched_at: string
          dispatched_by: string | null
          external_order_id: string | null
          id: string
          last_attempt_at: string | null
          last_error: string | null
          last_response: Json
          local_id: string | null
          order_id: string
          payload_snapshot: Json | null
          payment_type: number | null
          preparation_time: number | null
          refreshed_at: string | null
          resolution_note: string | null
          resolution_outcome: string | null
          resolved_at: string | null
          resolved_by: string | null
          scheduled_at: string | null
          scheduled_by: string | null
          scheduled_for: string | null
          status: string | null
          status_detail: string | null
          tracking_url: string | null
          updated_at: string
          value: number | null
        }
        Insert: {
          alshrouq_branch_id: string
          attempt_count?: number
          branch_no?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_order_id: string
          created_at?: string
          crm_agent_id?: string | null
          customer_address?: string | null
          customer_lat?: number | null
          customer_lng?: number | null
          details?: string | null
          dispatch_status?: string
          dispatched_at?: string
          dispatched_by?: string | null
          external_order_id?: string | null
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          last_response?: Json
          local_id?: string | null
          order_id: string
          payload_snapshot?: Json | null
          payment_type?: number | null
          preparation_time?: number | null
          refreshed_at?: string | null
          resolution_note?: string | null
          resolution_outcome?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          scheduled_at?: string | null
          scheduled_by?: string | null
          scheduled_for?: string | null
          status?: string | null
          status_detail?: string | null
          tracking_url?: string | null
          updated_at?: string
          value?: number | null
        }
        Update: {
          alshrouq_branch_id?: string
          attempt_count?: number
          branch_no?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_order_id?: string
          created_at?: string
          crm_agent_id?: string | null
          customer_address?: string | null
          customer_lat?: number | null
          customer_lng?: number | null
          details?: string | null
          dispatch_status?: string
          dispatched_at?: string
          dispatched_by?: string | null
          external_order_id?: string | null
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          last_response?: Json
          local_id?: string | null
          order_id?: string
          payload_snapshot?: Json | null
          payment_type?: number | null
          preparation_time?: number | null
          refreshed_at?: string | null
          resolution_note?: string | null
          resolution_outcome?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          scheduled_at?: string | null
          scheduled_by?: string | null
          scheduled_for?: string | null
          status?: string | null
          status_detail?: string | null
          tracking_url?: string | null
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "alshrouq_dispatches_branch_no_fkey"
            columns: ["branch_no"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["branch_no"]
          },
          {
            foreignKeyName: "alshrouq_dispatches_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      alshrouq_scheduler_state: {
        Row: {
          id: number
          last_error: string | null
          last_outcome: string | null
          last_poke_at: string | null
          last_poll_at: string | null
          last_request_id: number | null
          updated_at: string
        }
        Insert: {
          id?: number
          last_error?: string | null
          last_outcome?: string | null
          last_poke_at?: string | null
          last_poll_at?: string | null
          last_request_id?: number | null
          updated_at?: string
        }
        Update: {
          id?: number
          last_error?: string | null
          last_outcome?: string | null
          last_poke_at?: string | null
          last_poll_at?: string | null
          last_request_id?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      branch_imports: {
        Row: {
          actor_role: string | null
          file_name: string | null
          id: string
          imported_at: string
          imported_by: string | null
          mode: string
          notes: string | null
          reverted_from: string | null
          rows_added: number
          rows_failed: number
          rows_ignored: number
          rows_removed: number
          rows_total: number
          rows_updated: number
          snapshot: Json
          snapshot_rows: number
          source_file: string | null
          source_file_size: number | null
          source_file_type: string | null
          validation_summary: Json
        }
        Insert: {
          actor_role?: string | null
          file_name?: string | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          mode: string
          notes?: string | null
          reverted_from?: string | null
          rows_added?: number
          rows_failed?: number
          rows_ignored?: number
          rows_removed?: number
          rows_total?: number
          rows_updated?: number
          snapshot?: Json
          snapshot_rows?: number
          source_file?: string | null
          source_file_size?: number | null
          source_file_type?: string | null
          validation_summary?: Json
        }
        Update: {
          actor_role?: string | null
          file_name?: string | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          mode?: string
          notes?: string | null
          reverted_from?: string | null
          rows_added?: number
          rows_failed?: number
          rows_ignored?: number
          rows_removed?: number
          rows_total?: number
          rows_updated?: number
          snapshot?: Json
          snapshot_rows?: number
          source_file?: string | null
          source_file_size?: number | null
          source_file_type?: string | null
          validation_summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "branch_imports_reverted_from_fkey"
            columns: ["reverted_from"]
            isOneToOne: false
            referencedRelation: "branch_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          active: boolean
          address: string | null
          area_manager: string | null
          area_manager_phone: string | null
          branch_no: string
          city: string
          created_at: string
          duty_hours: number | null
          email: string | null
          friday_hours: string | null
          latitude: number | null
          location: unknown
          longitude: number | null
          maps_url: string | null
          phone: string | null
          scooter: boolean
          scooter_note: string | null
          updated_at: string
          working_hours: string | null
        }
        Insert: {
          active?: boolean
          address?: string | null
          area_manager?: string | null
          area_manager_phone?: string | null
          branch_no: string
          city: string
          created_at?: string
          duty_hours?: number | null
          email?: string | null
          friday_hours?: string | null
          latitude?: number | null
          location?: unknown
          longitude?: number | null
          maps_url?: string | null
          phone?: string | null
          scooter?: boolean
          scooter_note?: string | null
          updated_at?: string
          working_hours?: string | null
        }
        Update: {
          active?: boolean
          address?: string | null
          area_manager?: string | null
          area_manager_phone?: string | null
          branch_no?: string
          city?: string
          created_at?: string
          duty_hours?: number | null
          email?: string | null
          friday_hours?: string | null
          latitude?: number | null
          location?: unknown
          longitude?: number | null
          maps_url?: string | null
          phone?: string | null
          scooter?: boolean
          scooter_note?: string | null
          updated_at?: string
          working_hours?: string | null
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
      cdr_records: {
        Row: {
          business_day: string
          call_from_number: string | null
          call_id: string | null
          call_to_number: string | null
          raw: Json
          row_id: string
          synced_at: string
          ts: number
        }
        Insert: {
          business_day: string
          call_from_number?: string | null
          call_id?: string | null
          call_to_number?: string | null
          raw: Json
          row_id: string
          synced_at?: string
          ts: number
        }
        Update: {
          business_day?: string
          call_from_number?: string | null
          call_id?: string | null
          call_to_number?: string | null
          raw?: Json
          row_id?: string
          synced_at?: string
          ts?: number
        }
        Relationships: []
      }
      cdr_sync_days: {
        Row: {
          business_day: string
          row_count: number
          synced_at: string
        }
        Insert: {
          business_day: string
          row_count?: number
          synced_at?: string
        }
        Update: {
          business_day?: string
          row_count?: number
          synced_at?: string
        }
        Relationships: []
      }
      cdr_sync_state: {
        Row: {
          id: number
          last_days: number
          last_error: string | null
          last_rows: number
          last_run_at: string | null
          last_status: string
          last_synced_epoch: number | null
          lease_until: string | null
          updated_at: string
        }
        Insert: {
          id?: number
          last_days?: number
          last_error?: string | null
          last_rows?: number
          last_run_at?: string | null
          last_status?: string
          last_synced_epoch?: number | null
          lease_until?: string | null
          updated_at?: string
        }
        Update: {
          id?: number
          last_days?: number
          last_error?: string | null
          last_rows?: number
          last_run_at?: string | null
          last_status?: string
          last_synced_epoch?: number | null
          lease_until?: string | null
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
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
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
      order_stars: {
        Row: {
          created_at: string
          id: string
          order_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          order_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          order_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_stars_order_id_fkey"
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
          alshrouq_lat: number | null
          alshrouq_lng: number | null
          alshrouq_map_url: string | null
          alshrouq_payment_type: number | null
          branch_no: string | null
          call_center_verified: boolean
          created_at: string
          created_by: string | null
          customer_name: string | null
          customer_phone: string | null
          delivery_type: string | null
          display_no: string
          id: string
          invoice_no: string | null
          invoice_value: number | null
          invoices_verified: boolean
          notes: string | null
          order_date: string
          order_type: string
          status: string
          team: Database["public"]["Enums"]["app_role"]
          updated_at: string
        }
        Insert: {
          agent_id: string
          alshrouq_lat?: number | null
          alshrouq_lng?: number | null
          alshrouq_map_url?: string | null
          alshrouq_payment_type?: number | null
          branch_no?: string | null
          call_center_verified?: boolean
          created_at?: string
          created_by?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          delivery_type?: string | null
          display_no?: string
          id?: string
          invoice_no?: string | null
          invoice_value?: number | null
          invoices_verified?: boolean
          notes?: string | null
          order_date?: string
          order_type: string
          status?: string
          team: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Update: {
          agent_id?: string
          alshrouq_lat?: number | null
          alshrouq_lng?: number | null
          alshrouq_map_url?: string | null
          alshrouq_payment_type?: number | null
          branch_no?: string | null
          call_center_verified?: boolean
          created_at?: string
          created_by?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          delivery_type?: string | null
          display_no?: string
          id?: string
          invoice_no?: string | null
          invoice_value?: number | null
          invoices_verified?: boolean
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
      orders_verification_snapshot_20260815: {
        Row: {
          agent_id: string | null
          captured_at: string | null
          created_at: string | null
          display_no: string | null
          has_manual_history: boolean | null
          invoice_no: string | null
          last_manual_actor: string | null
          last_manual_at: string | null
          last_manual_verified: boolean | null
          order_date: string | null
          order_id: string | null
          snapshot_call_center_verified: boolean | null
          snapshot_invoice_value: number | null
          snapshot_invoices_verified: boolean | null
          status: string | null
          team: Database["public"]["Enums"]["app_role"] | null
          updated_at: string | null
        }
        Insert: {
          agent_id?: string | null
          captured_at?: string | null
          created_at?: string | null
          display_no?: string | null
          has_manual_history?: boolean | null
          invoice_no?: string | null
          last_manual_actor?: string | null
          last_manual_at?: string | null
          last_manual_verified?: boolean | null
          order_date?: string | null
          order_id?: string | null
          snapshot_call_center_verified?: boolean | null
          snapshot_invoice_value?: number | null
          snapshot_invoices_verified?: boolean | null
          status?: string | null
          team?: Database["public"]["Enums"]["app_role"] | null
          updated_at?: string | null
        }
        Update: {
          agent_id?: string | null
          captured_at?: string | null
          created_at?: string | null
          display_no?: string | null
          has_manual_history?: boolean | null
          invoice_no?: string | null
          last_manual_actor?: string | null
          last_manual_at?: string | null
          last_manual_verified?: boolean | null
          order_date?: string | null
          order_id?: string | null
          snapshot_call_center_verified?: boolean | null
          snapshot_invoice_value?: number | null
          snapshot_invoices_verified?: boolean | null
          status?: string | null
          team?: Database["public"]["Enums"]["app_role"] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          active: boolean
          agent_code: string | null
          avatar_url: string | null
          created_at: string
          full_name: string
          id: string
          must_change_password: boolean
          must_change_password_expires_at: string | null
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
          must_change_password?: boolean
          must_change_password_expires_at?: string | null
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
          must_change_password?: boolean
          must_change_password_expires_at?: string | null
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
      shams_crm_agent_links: {
        Row: {
          active: boolean
          created_at: string
          crm_user_id: string | null
          crm_username: string
          last_error: string | null
          team: string | null
          updated_at: string
          user_id: string
          vault_key: string | null
          verified_at: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          crm_user_id?: string | null
          crm_username: string
          last_error?: string | null
          team?: string | null
          updated_at?: string
          user_id: string
          vault_key?: string | null
          verified_at?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          crm_user_id?: string | null
          crm_username?: string
          last_error?: string | null
          team?: string | null
          updated_at?: string
          user_id?: string
          vault_key?: string | null
          verified_at?: string | null
        }
        Relationships: []
      }
      shams_sync_runs: {
        Row: {
          branches_seen: number | null
          branches_targeted: number | null
          completed_at: string | null
          created_at: string
          duration_seconds: number | null
          error_summary: string | null
          execution_source: string
          id: string
          last_observed_at: string | null
          pages_fetched: number | null
          requested_by: string | null
          rows_changed: number | null
          rows_seen: number | null
          schedule_slot_id: string | null
          scheduled_for: string | null
          shams_run_id: string | null
          skip_reason: string | null
          source_timestamps_corrected: boolean
          started_at: string | null
          status: string
          sync_type: string
          triggered_at: string
          updated_at: string
        }
        Insert: {
          branches_seen?: number | null
          branches_targeted?: number | null
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_summary?: string | null
          execution_source?: string
          id?: string
          last_observed_at?: string | null
          pages_fetched?: number | null
          requested_by?: string | null
          rows_changed?: number | null
          rows_seen?: number | null
          schedule_slot_id?: string | null
          scheduled_for?: string | null
          shams_run_id?: string | null
          skip_reason?: string | null
          source_timestamps_corrected?: boolean
          started_at?: string | null
          status: string
          sync_type: string
          triggered_at?: string
          updated_at?: string
        }
        Update: {
          branches_seen?: number | null
          branches_targeted?: number | null
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_summary?: string | null
          execution_source?: string
          id?: string
          last_observed_at?: string | null
          pages_fetched?: number | null
          requested_by?: string | null
          rows_changed?: number | null
          rows_seen?: number | null
          schedule_slot_id?: string | null
          scheduled_for?: string | null
          shams_run_id?: string | null
          skip_reason?: string | null
          source_timestamps_corrected?: boolean
          started_at?: string | null
          status?: string
          sync_type?: string
          triggered_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      shams_sync_schedule_slots: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          last_scheduled_for: string | null
          local_time: string
          next_due_at: string | null
          sync_promotions: boolean
          sync_stock: boolean
          time_zone: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          last_scheduled_for?: string | null
          local_time: string
          next_due_at?: string | null
          sync_promotions?: boolean
          sync_stock?: boolean
          time_zone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          last_scheduled_for?: string | null
          local_time?: string
          next_due_at?: string | null
          sync_promotions?: boolean
          sync_stock?: boolean
          time_zone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      shams_sync_scheduler_state: {
        Row: {
          id: number
          last_error: string | null
          last_outcome: string | null
          last_poke_at: string | null
          last_poll_at: string | null
          last_request_id: number | null
          last_task: string | null
          updated_at: string
        }
        Insert: {
          id?: number
          last_error?: string | null
          last_outcome?: string | null
          last_poke_at?: string | null
          last_poll_at?: string | null
          last_request_id?: number | null
          last_task?: string | null
          updated_at?: string
        }
        Update: {
          id?: number
          last_error?: string | null
          last_outcome?: string | null
          last_poke_at?: string | null
          last_poll_at?: string | null
          last_request_id?: number | null
          last_task?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      shams_sync_settings: {
        Row: {
          automation_enabled: boolean
          id: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          automation_enabled?: boolean
          id?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          automation_enabled?: boolean
          id?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      telesales_customers: {
        Row: {
          alternate_names: string[]
          created_at: string
          display_name: string | null
          first_seen_at: string
          id: string
          last_seen_at: string
          mis_customer_id: string | null
          mis_synced_at: string | null
          phone: string
          updated_at: string
        }
        Insert: {
          alternate_names?: string[]
          created_at?: string
          display_name?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          mis_customer_id?: string | null
          mis_synced_at?: string | null
          phone: string
          updated_at?: string
        }
        Update: {
          alternate_names?: string[]
          created_at?: string
          display_name?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          mis_customer_id?: string | null
          mis_synced_at?: string | null
          phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      telesales_followups: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          due_on: string
          due_time: string | null
          id: string
          lead_id: string
          notes: string | null
          reason: string | null
          result: string | null
          status: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          due_on: string
          due_time?: string | null
          id?: string
          lead_id: string
          notes?: string | null
          reason?: string | null
          result?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          due_on?: string
          due_time?: string | null
          id?: string
          lead_id?: string
          notes?: string | null
          reason?: string | null
          result?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telesales_followups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_lead_lifecycle"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_followups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      telesales_generation_runs: {
        Row: {
          actor_id: string | null
          anchor_date: string
          candidates: number
          completed_at: string | null
          error_summary: string | null
          errors: number
          execution_source: string
          filters: Json | null
          id: string
          import_id: string | null
          lead_type: string
          leads_created: number
          skipped_duplicate: number
          skipped_ineligible: number
          started_at: string
          status: string
          window_from: string | null
          window_to: string | null
        }
        Insert: {
          actor_id?: string | null
          anchor_date: string
          candidates?: number
          completed_at?: string | null
          error_summary?: string | null
          errors?: number
          execution_source?: string
          filters?: Json | null
          id?: string
          import_id?: string | null
          lead_type: string
          leads_created?: number
          skipped_duplicate?: number
          skipped_ineligible?: number
          started_at?: string
          status?: string
          window_from?: string | null
          window_to?: string | null
        }
        Update: {
          actor_id?: string | null
          anchor_date?: string
          candidates?: number
          completed_at?: string | null
          error_summary?: string | null
          errors?: number
          execution_source?: string
          filters?: Json | null
          id?: string
          import_id?: string | null
          lead_type?: string
          leads_created?: number
          skipped_duplicate?: number
          skipped_ineligible?: number
          started_at?: string
          status?: string
          window_from?: string | null
          window_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telesales_generation_runs_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "telesales_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      telesales_imports: {
        Row: {
          actor_role: string | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          archived_followups: number | null
          archived_leads: number | null
          archived_source_records: number | null
          column_mapping: Json | null
          content_digest: string | null
          error_summary: string | null
          file_name: string
          file_size: number | null
          id: string
          imported_at: string
          imported_by: string | null
          issues: Json
          rows_duplicate: number
          rows_rejected: number
          rows_stored: number
          rows_total: number
          sheet_name: string | null
          source_type: string
          status: string
        }
        Insert: {
          actor_role?: string | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          archived_followups?: number | null
          archived_leads?: number | null
          archived_source_records?: number | null
          column_mapping?: Json | null
          content_digest?: string | null
          error_summary?: string | null
          file_name: string
          file_size?: number | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          issues?: Json
          rows_duplicate?: number
          rows_rejected?: number
          rows_stored?: number
          rows_total?: number
          sheet_name?: string | null
          source_type: string
          status?: string
        }
        Update: {
          actor_role?: string | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          archived_followups?: number | null
          archived_leads?: number | null
          archived_source_records?: number | null
          column_mapping?: Json | null
          content_digest?: string | null
          error_summary?: string | null
          file_name?: string
          file_size?: number | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          issues?: Json
          rows_duplicate?: number
          rows_rejected?: number
          rows_stored?: number
          rows_total?: number
          sheet_name?: string | null
          source_type?: string
          status?: string
        }
        Relationships: []
      }
      telesales_lead_activities: {
        Row: {
          activity_type: string
          actor_id: string | null
          actor_name: string | null
          actor_role: string | null
          created_at: string
          from_status: string | null
          id: string
          lead_id: string
          metadata: Json
          note: string | null
          outcome: string | null
          to_status: string | null
        }
        Insert: {
          activity_type: string
          actor_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          lead_id: string
          metadata?: Json
          note?: string | null
          outcome?: string | null
          to_status?: string | null
        }
        Update: {
          activity_type?: string
          actor_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          lead_id?: string
          metadata?: Json
          note?: string | null
          outcome?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telesales_lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_lead_lifecycle"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      telesales_leads: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_by: string | null
          assigned_to: string | null
          branch_no: string | null
          channel: string | null
          city: string | null
          closed_at: string | null
          closed_reason: string | null
          contact_attempts: number
          converted_at: string | null
          converted_value: number | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          customer_ref: string | null
          cycle_number: number
          dedup_key: string
          document_no: string | null
          facility: string | null
          first_contacted_at: string | null
          generation_reason: string | null
          generation_run_id: string | null
          id: string
          invoice_checked_at: string | null
          invoice_discrepancies: string[]
          invoice_match_status: string | null
          invoice_matched_branch_no: string | null
          invoice_matched_doc_no: string | null
          item_code: string | null
          item_name: string | null
          last_contacted_at: string | null
          last_contacted_by: string | null
          last_outcome: string | null
          lead_type: string
          next_followup_on: string | null
          order_id: string | null
          parent_lead_id: string | null
          patient_id: string | null
          phone: string | null
          phone_alternates: string[]
          prescription_no: string | null
          priority: number
          product_family: string | null
          product_strength: string | null
          quantity: number | null
          source_date: string | null
          source_record_id: string | null
          status: string
          total_value: number | null
          updated_at: string
        }
        Insert: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          branch_no?: string | null
          channel?: string | null
          city?: string | null
          closed_at?: string | null
          closed_reason?: string | null
          contact_attempts?: number
          converted_at?: string | null
          converted_value?: number | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          customer_ref?: string | null
          cycle_number?: number
          dedup_key: string
          document_no?: string | null
          facility?: string | null
          first_contacted_at?: string | null
          generation_reason?: string | null
          generation_run_id?: string | null
          id?: string
          invoice_checked_at?: string | null
          invoice_discrepancies?: string[]
          invoice_match_status?: string | null
          invoice_matched_branch_no?: string | null
          invoice_matched_doc_no?: string | null
          item_code?: string | null
          item_name?: string | null
          last_contacted_at?: string | null
          last_contacted_by?: string | null
          last_outcome?: string | null
          lead_type: string
          next_followup_on?: string | null
          order_id?: string | null
          parent_lead_id?: string | null
          patient_id?: string | null
          phone?: string | null
          phone_alternates?: string[]
          prescription_no?: string | null
          priority?: number
          product_family?: string | null
          product_strength?: string | null
          quantity?: number | null
          source_date?: string | null
          source_record_id?: string | null
          status?: string
          total_value?: number | null
          updated_at?: string
        }
        Update: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          branch_no?: string | null
          channel?: string | null
          city?: string | null
          closed_at?: string | null
          closed_reason?: string | null
          contact_attempts?: number
          converted_at?: string | null
          converted_value?: number | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          customer_ref?: string | null
          cycle_number?: number
          dedup_key?: string
          document_no?: string | null
          facility?: string | null
          first_contacted_at?: string | null
          generation_reason?: string | null
          generation_run_id?: string | null
          id?: string
          invoice_checked_at?: string | null
          invoice_discrepancies?: string[]
          invoice_match_status?: string | null
          invoice_matched_branch_no?: string | null
          invoice_matched_doc_no?: string | null
          item_code?: string | null
          item_name?: string | null
          last_contacted_at?: string | null
          last_contacted_by?: string | null
          last_outcome?: string | null
          lead_type?: string
          next_followup_on?: string | null
          order_id?: string | null
          parent_lead_id?: string | null
          patient_id?: string | null
          phone?: string | null
          phone_alternates?: string[]
          prescription_no?: string | null
          priority?: number
          product_family?: string | null
          product_strength?: string | null
          quantity?: number | null
          source_date?: string | null
          source_record_id?: string | null
          status?: string
          total_value?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telesales_leads_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "telesales_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_generation_run_id_fkey"
            columns: ["generation_run_id"]
            isOneToOne: false
            referencedRelation: "telesales_generation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_parent_lead_id_fkey"
            columns: ["parent_lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_lead_lifecycle"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_parent_lead_id_fkey"
            columns: ["parent_lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: false
            referencedRelation: "telesales_source_records"
            referencedColumns: ["id"]
          },
        ]
      }
      telesales_patient_contacts: {
        Row: {
          added_at: string
          added_by: string | null
          id: string
          notes: string | null
          patient_id: string
          phone: string
          phone_raw: string | null
          prescription_no: string | null
          source: string
          superseded_at: string | null
          superseded_by: string | null
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          id?: string
          notes?: string | null
          patient_id: string
          phone: string
          phone_raw?: string | null
          prescription_no?: string | null
          source?: string
          superseded_at?: string | null
          superseded_by?: string | null
        }
        Update: {
          added_at?: string
          added_by?: string | null
          id?: string
          notes?: string | null
          patient_id?: string
          phone?: string
          phone_raw?: string | null
          prescription_no?: string | null
          source?: string
          superseded_at?: string | null
          superseded_by?: string | null
        }
        Relationships: []
      }
      telesales_product_aliases: {
        Row: {
          active: boolean
          alias_item_code: string
          alias_name_snapshot: string | null
          canonical_item_code: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          active?: boolean
          alias_item_code: string
          alias_name_snapshot?: string | null
          canonical_item_code: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          active?: boolean
          alias_item_code?: string
          alias_name_snapshot?: string | null
          canonical_item_code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telesales_product_aliases_canonical_item_code_fkey"
            columns: ["canonical_item_code"]
            isOneToOne: false
            referencedRelation: "telesales_products"
            referencedColumns: ["item_code"]
          },
        ]
      }
      telesales_product_patterns: {
        Row: {
          active: boolean
          created_at: string
          eligible: boolean
          family: string
          id: string
          notes: string | null
          pattern: string
          priority: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          eligible?: boolean
          family: string
          id?: string
          notes?: string | null
          pattern: string
          priority?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          eligible?: boolean
          family?: string
          id?: string
          notes?: string | null
          pattern?: string
          priority?: number
          updated_at?: string
        }
        Relationships: []
      }
      telesales_product_relations: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          from_item_code: string
          id: string
          note: string | null
          to_item_code: string
          to_item_name: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          from_item_code: string
          id?: string
          note?: string | null
          to_item_code: string
          to_item_name: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          from_item_code?: string
          id?: string
          note?: string | null
          to_item_code?: string
          to_item_name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      telesales_products: {
        Row: {
          active: boolean
          category: string | null
          created_at: string
          eligible_cash: boolean
          eligible_retention: boolean
          family: string
          item_code: string
          item_name: string
          notes: string | null
          refill_days: number | null
          strength: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          category?: string | null
          created_at?: string
          eligible_cash?: boolean
          eligible_retention?: boolean
          family: string
          item_code: string
          item_name: string
          notes?: string | null
          refill_days?: number | null
          strength?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string | null
          created_at?: string
          eligible_cash?: boolean
          eligible_retention?: boolean
          family?: string
          item_code?: string
          item_name?: string
          notes?: string | null
          refill_days?: number | null
          strength?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      telesales_scheduler_state: {
        Row: {
          id: number
          last_anchor: string | null
          last_error: string | null
          last_outcome: string | null
          last_poke_at: string | null
          last_request_id: number | null
          updated_at: string
        }
        Insert: {
          id?: number
          last_anchor?: string | null
          last_error?: string | null
          last_outcome?: string | null
          last_poke_at?: string | null
          last_request_id?: number | null
          updated_at?: string
        }
        Update: {
          id?: number
          last_anchor?: string | null
          last_error?: string | null
          last_outcome?: string | null
          last_poke_at?: string | null
          last_request_id?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      telesales_settings: {
        Row: {
          automation_enabled: boolean
          cash_window_days: number
          cash_window_lag_days: number
          generation_hour: number
          id: boolean
          retention_overdue_grace_days: number
          updated_at: string
          updated_by: string | null
          wasfaty_window_days: number
        }
        Insert: {
          automation_enabled?: boolean
          cash_window_days?: number
          cash_window_lag_days?: number
          generation_hour?: number
          id?: boolean
          retention_overdue_grace_days?: number
          updated_at?: string
          updated_by?: string | null
          wasfaty_window_days?: number
        }
        Update: {
          automation_enabled?: boolean
          cash_window_days?: number
          cash_window_lag_days?: number
          generation_hour?: number
          id?: boolean
          retention_overdue_grace_days?: number
          updated_at?: string
          updated_by?: string | null
          wasfaty_window_days?: number
        }
        Relationships: []
      }
      telesales_source_records: {
        Row: {
          archived_at: string | null
          branch_no: string | null
          callback_date: string | null
          channel: string | null
          city: string | null
          content_hash: string
          created_at: string
          customer_name: string | null
          customer_ref: string | null
          dispense_time: string | null
          document_no: string | null
          facility: string | null
          fill_date: string | null
          id: string
          import_id: string
          item_code: string | null
          item_name: string | null
          patient_id: string | null
          phone: string | null
          phone_alternates: string[]
          phone_raw: string | null
          phone_rejection: string | null
          prescription_no: string | null
          quantity: number | null
          raw: Json
          row_number: number
          source_date: string | null
          source_type: string
          total_value: number | null
          unit_price: number | null
        }
        Insert: {
          archived_at?: string | null
          branch_no?: string | null
          callback_date?: string | null
          channel?: string | null
          city?: string | null
          content_hash: string
          created_at?: string
          customer_name?: string | null
          customer_ref?: string | null
          dispense_time?: string | null
          document_no?: string | null
          facility?: string | null
          fill_date?: string | null
          id?: string
          import_id: string
          item_code?: string | null
          item_name?: string | null
          patient_id?: string | null
          phone?: string | null
          phone_alternates?: string[]
          phone_raw?: string | null
          phone_rejection?: string | null
          prescription_no?: string | null
          quantity?: number | null
          raw?: Json
          row_number: number
          source_date?: string | null
          source_type: string
          total_value?: number | null
          unit_price?: number | null
        }
        Update: {
          archived_at?: string | null
          branch_no?: string | null
          callback_date?: string | null
          channel?: string | null
          city?: string | null
          content_hash?: string
          created_at?: string
          customer_name?: string | null
          customer_ref?: string | null
          dispense_time?: string | null
          document_no?: string | null
          facility?: string | null
          fill_date?: string | null
          id?: string
          import_id?: string
          item_code?: string | null
          item_name?: string | null
          patient_id?: string | null
          phone?: string | null
          phone_alternates?: string[]
          phone_raw?: string | null
          phone_rejection?: string | null
          prescription_no?: string | null
          quantity?: number | null
          raw?: Json
          row_number?: number
          source_date?: string | null
          source_type?: string
          total_value?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "telesales_source_records_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "telesales_imports"
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
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      telesales_lead_lifecycle: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_by: string | null
          assigned_to: string | null
          branch_no: string | null
          canonical_item_code: string | null
          canonical_via: string | null
          channel: string | null
          city: string | null
          closed_at: string | null
          closed_reason: string | null
          contact_attempts: number | null
          converted_at: string | null
          converted_value: number | null
          created_at: string | null
          customer_id: string | null
          customer_name: string | null
          customer_ref: string | null
          cycle_number: number | null
          dedup_key: string | null
          document_no: string | null
          facility: string | null
          first_contacted_at: string | null
          generation_reason: string | null
          generation_run_id: string | null
          id: string | null
          invoice_checked_at: string | null
          invoice_discrepancies: string[] | null
          invoice_match_status: string | null
          invoice_matched_branch_no: string | null
          invoice_matched_doc_no: string | null
          item_code: string | null
          item_name: string | null
          last_contacted_at: string | null
          last_contacted_by: string | null
          last_outcome: string | null
          last_purchased_on: string | null
          lead_type: string | null
          lifecycle: string | null
          next_followup_on: string | null
          order_id: string | null
          parent_lead_id: string | null
          patient_id: string | null
          phone: string | null
          phone_alternates: string[] | null
          prescription_no: string | null
          priority: number | null
          product_family: string | null
          product_strength: string | null
          quantity: number | null
          refill_cycle_days: number | null
          refill_due_on: string | null
          source_date: string | null
          source_record_id: string | null
          stale_after: string | null
          status: string | null
          total_value: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telesales_leads_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "telesales_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_generation_run_id_fkey"
            columns: ["generation_run_id"]
            isOneToOne: false
            referencedRelation: "telesales_generation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_parent_lead_id_fkey"
            columns: ["parent_lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_lead_lifecycle"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_parent_lead_id_fkey"
            columns: ["parent_lead_id"]
            isOneToOne: false
            referencedRelation: "telesales_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telesales_leads_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: false
            referencedRelation: "telesales_source_records"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      alshrouq_dispatch_due: { Args: never; Returns: number }
      branches_nearby: {
        Args: {
          _lat: number
          _limit?: number
          _lng: number
          _radius_m?: number
          _scooter_only?: boolean
        }
        Returns: {
          address: string
          branch_no: string
          city: string
          distance_m: number
          duty_hours: number
          latitude: number
          longitude: number
          phone: string
          scooter: boolean
          working_hours: string
        }[]
      }
      cdr_rows_by_number: {
        Args: { p_from: string; p_numbers: string[]; p_to: string }
        Returns: Json
      }
      cdr_window_rows: {
        Args: { p_days: string[] }
        Returns: {
          business_day: string
          rows: Json
        }[]
      }
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
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enablelongtransactions: { Args: never; Returns: string }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      get_my_profile: {
        Args: never
        Returns: {
          active: boolean
          agent_code: string | null
          avatar_url: string | null
          created_at: string
          full_name: string
          id: string
          must_change_password: boolean
          must_change_password_expires_at: string | null
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
      gettransactionid: { Args: never; Returns: unknown }
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
      is_owner: { Args: { _user_id: string }; Returns: boolean }
      longtransactionsenabled: { Args: never; Returns: boolean }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
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
      order_fulfillment: { Args: { _delivery_type: string }; Returns: string }
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
          completed_cash_count: number
          completed_count: number
          completed_sales: number
          completed_wasfaty_count: number
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
          alshrouq_lat: number | null
          alshrouq_lng: number | null
          alshrouq_map_url: string | null
          alshrouq_payment_type: number | null
          branch_no: string | null
          call_center_verified: boolean
          created_at: string
          created_by: string | null
          customer_name: string | null
          customer_phone: string | null
          delivery_type: string | null
          display_no: string
          id: string
          invoice_no: string | null
          invoice_value: number | null
          invoices_verified: boolean
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
          _fulfillment?: string
          _mine?: boolean
          _q?: string
          _starred?: boolean
          _status?: string
          _team?: string
          _to: string
          _verification?: string
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
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      record_invoice_verification: {
        Args: { _entries: Json; _order_id: string }
        Returns: Json
      }
      shams_crm_agent_secret: { Args: { _user_id: string }; Returns: string }
      shams_crm_forget_agent_secret: {
        Args: { _user_id: string }
        Returns: undefined
      }
      shams_crm_store_agent_secret: {
        Args: { _password: string; _user_id: string }
        Returns: string
      }
      shams_sync_tick: { Args: never; Returns: number }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      telesales_agent_workload: {
        Args: { _day?: string }
        Returns: {
          agent_id: string
          agent_name: string
          contacted_today: number
          converted_today: number
          followups_due: number
          followups_overdue: number
          open_leads: number
        }[]
      }
      telesales_archive_impact: {
        Args: { _import_id: string }
        Returns: {
          customers_affected: number
          followups: number
          leads: number
          leads_retained: number
          leads_with_activity: number
          source_records: number
        }[]
      }
      telesales_archive_import: {
        Args: {
          _actor: string
          _at?: string
          _import_id: string
          _reason: string
        }
        Returns: {
          followups: number
          leads: number
          source_records: number
        }[]
      }
      telesales_contact_history: {
        Args: { _limit?: number; _phone: string }
        Returns: {
          activity_id: string
          agent_id: string
          agent_name: string
          item_name: string
          lead_id: string
          lead_type: string
          note: string
          occurred_at: string
          outcome: string
        }[]
      }
      telesales_generation_tick: { Args: never; Returns: number }
      telesales_import_summary: {
        Args: { _limit?: number }
        Returns: {
          actor_role: string
          archive_reason: string
          archived_at: string
          archived_leads: number
          file_name: string
          id: string
          imported_at: string
          imported_by: string
          importer_name: string
          live_leads: number
          live_source_records: number
          rows_duplicate: number
          rows_rejected: number
          rows_stored: number
          rows_total: number
          sheet_name: string
          source_type: string
          status: string
          worked_leads: number
        }[]
      }
      telesales_management_summary: {
        Args: { _day?: string }
        Returns: {
          metric: string
          value: number
        }[]
      }
      telesales_restore_import: {
        Args: { _import_id: string }
        Returns: {
          leads: number
        }[]
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
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
        | "supervisor"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
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
      app_role: [
        "admin",
        "customer_care",
        "telesales",
        "auditor",
        "owner",
        "call_center",
        "supervisor",
      ],
    },
  },
} as const
