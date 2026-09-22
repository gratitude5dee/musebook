export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      access_grants: {
        Row: {
          content_hash: string
          expires_at: string | null
          granted_at: string
          id: string
          payer: string
          post_id: string | null
          revoked_at: string | null
          settlement_id: string
          subject_agent_id: string | null
          subject_user_id: string | null
        }
        Insert: {
          content_hash: string
          expires_at?: string | null
          granted_at?: string
          id?: string
          payer: string
          post_id?: string | null
          revoked_at?: string | null
          settlement_id: string
          subject_agent_id?: string | null
          subject_user_id?: string | null
        }
        Update: {
          content_hash?: string
          expires_at?: string | null
          granted_at?: string
          id?: string
          payer?: string
          post_id?: string | null
          revoked_at?: string | null
          settlement_id?: string
          subject_agent_id?: string | null
          subject_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "access_grants_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "x402_settlements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_subject_agent_id_fkey"
            columns: ["subject_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_subject_user_id_fkey"
            columns: ["subject_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      action_events: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_events_model_version_fkey"
            columns: ["model_version"]
            isOneToOne: false
            referencedRelation: "model_registry"
            referencedColumns: ["model_version"]
          },
          {
            foreignKeyName: "action_events_weights_version_fkey"
            columns: ["weights_version"]
            isOneToOne: false
            referencedRelation: "ranking_weights"
            referencedColumns: ["weights_version"]
          },
        ]
      }
      action_events_agent: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: []
      }
      action_events_agent_20260922: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: []
      }
      action_events_agent_20260923: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: []
      }
      action_events_daily: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          day: string
          dwell_ms: number
          n: number
          post_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          day: string
          dwell_ms?: number
          n?: number
          post_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          day?: string
          dwell_ms?: number
          n?: number
          post_id?: string
        }
        Relationships: []
      }
      action_events_human: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: []
      }
      action_events_human_20260922: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: []
      }
      action_events_human_20260923: {
        Row: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client: Json
          comment_id: string | null
          dwell_ms: number | null
          event_id: string
          ip_hash: string | null
          model_version: string
          occurred_at: string
          position: number
          post_id: string | null
          request_id: string | null
          slate_id: string
          surface: string
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version: string
          occurred_at?: string
          position: number
          post_id?: string | null
          request_id?: string | null
          slate_id: string
          surface: string
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_kind"]
          actor_agent_id?: string | null
          actor_plane?: Database["public"]["Enums"]["actor_plane"]
          client?: Json
          comment_id?: string | null
          dwell_ms?: number | null
          event_id?: string
          ip_hash?: string | null
          model_version?: string
          occurred_at?: string
          position?: number
          post_id?: string | null
          request_id?: string | null
          slate_id?: string
          surface?: string
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: []
      }
      agent_identities: {
        Row: {
          created_at: string
          directory_keyid: string | null
          directory_url: string | null
          display_name: string
          first_seen_at: string
          id: string
          is_blocked: boolean
          last_seen_at: string | null
          moltbook_id: string | null
          owner_user_id: string | null
          registry_token_id: number | null
          signature_agent: string | null
          slug: string
          updated_at: string
          user_agent_pattern: string | null
          verification: Database["public"]["Enums"]["agent_verification"]
          wallet_address: string | null
        }
        Insert: {
          created_at?: string
          directory_keyid?: string | null
          directory_url?: string | null
          display_name: string
          first_seen_at?: string
          id?: string
          is_blocked?: boolean
          last_seen_at?: string | null
          moltbook_id?: string | null
          owner_user_id?: string | null
          registry_token_id?: number | null
          signature_agent?: string | null
          slug: string
          updated_at?: string
          user_agent_pattern?: string | null
          verification?: Database["public"]["Enums"]["agent_verification"]
          wallet_address?: string | null
        }
        Update: {
          created_at?: string
          directory_keyid?: string | null
          directory_url?: string | null
          display_name?: string
          first_seen_at?: string
          id?: string
          is_blocked?: boolean
          last_seen_at?: string | null
          moltbook_id?: string | null
          owner_user_id?: string | null
          registry_token_id?: number | null
          signature_agent?: string | null
          slug?: string
          updated_at?: string
          user_agent_pattern?: string | null
          verification?: Database["public"]["Enums"]["agent_verification"]
          wallet_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_identities_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_post_schedules: {
        Row: {
          approval_mode: string
          approval_n: number | null
          cadence: string
          created_at: string
          delegation_id: string
          enabled: boolean | null
          id: string
          last_run_at: string | null
          max_posts_per_day: number
          next_run_at: string | null
          prompt_template: string | null
          target_platforms: string[]
          updated_at: string
        }
        Insert: {
          approval_mode?: string
          approval_n?: number | null
          cadence: string
          created_at?: string
          delegation_id: string
          enabled?: boolean | null
          id?: string
          last_run_at?: string | null
          max_posts_per_day?: number
          next_run_at?: string | null
          prompt_template?: string | null
          target_platforms?: string[]
          updated_at?: string
        }
        Update: {
          approval_mode?: string
          approval_n?: number | null
          cadence?: string
          created_at?: string
          delegation_id?: string
          enabled?: boolean | null
          id?: string
          last_run_at?: string | null
          max_posts_per_day?: number
          next_run_at?: string | null
          prompt_template?: string | null
          target_platforms?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_post_schedules_delegation_id_fkey"
            columns: ["delegation_id"]
            isOneToOne: false
            referencedRelation: "delegations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_spend_reservations: {
        Row: {
          actual_atomic: number | null
          closed_at: string | null
          created_at: string
          delegation_id: string
          estimate_atomic: number
          external_kind: string | null
          external_ref: string | null
          id: string
          idempotency_key: string
          purpose: string
          state: string
          window_start: string
        }
        Insert: {
          actual_atomic?: number | null
          closed_at?: string | null
          created_at?: string
          delegation_id: string
          estimate_atomic: number
          external_kind?: string | null
          external_ref?: string | null
          id?: string
          idempotency_key: string
          purpose: string
          state?: string
          window_start: string
        }
        Update: {
          actual_atomic?: number | null
          closed_at?: string | null
          created_at?: string
          delegation_id?: string
          estimate_atomic?: number
          external_kind?: string | null
          external_ref?: string | null
          id?: string
          idempotency_key?: string
          purpose?: string
          state?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_spend_reservations_delegation_id_fkey"
            columns: ["delegation_id"]
            isOneToOne: false
            referencedRelation: "delegations"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_queue: {
        Row: {
          decided_at: string | null
          decided_by_user_id: string | null
          delegation_id: string
          expires_at: string
          id: string
          kind: string
          owner_user_id: string
          payload: Json
          requested_at: string
          state: Database["public"]["Enums"]["approval_state"]
        }
        Insert: {
          decided_at?: string | null
          decided_by_user_id?: string | null
          delegation_id: string
          expires_at?: string
          id?: string
          kind: string
          owner_user_id: string
          payload: Json
          requested_at?: string
          state?: Database["public"]["Enums"]["approval_state"]
        }
        Update: {
          decided_at?: string | null
          decided_by_user_id?: string | null
          delegation_id?: string
          expires_at?: string
          id?: string
          kind?: string
          owner_user_id?: string
          payload?: Json
          requested_at?: string
          state?: Database["public"]["Enums"]["approval_state"]
        }
        Relationships: [
          {
            foreignKeyName: "approval_queue_decided_by_user_id_fkey"
            columns: ["decided_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_queue_delegation_id_fkey"
            columns: ["delegation_id"]
            isOneToOne: false
            referencedRelation: "delegations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_queue_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      artifacts: {
        Row: {
          bundle_url: string
          byte_len: number
          created_at: string
          csp_profile: string
          entry_path: string
          id: string
          kind: string
          post_id: string
          poster_asset_id: string | null
          sha256: string
        }
        Insert: {
          bundle_url: string
          byte_len: number
          created_at?: string
          csp_profile?: string
          entry_path?: string
          id?: string
          kind: string
          post_id: string
          poster_asset_id?: string | null
          sha256: string
        }
        Update: {
          bundle_url?: string
          byte_len?: number
          created_at?: string
          csp_profile?: string
          entry_path?: string
          id?: string
          kind?: string
          post_id?: string
          poster_asset_id?: string | null
          sha256?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifacts_poster_fk"
            columns: ["poster_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          alt_text: string | null
          byte_len: number
          c2pa_manifest: Json | null
          content_type: string
          created_at: string
          duration_ms: number | null
          height: number | null
          id: string
          object_key: string
          owner_user_id: string
          sha256: string
          storage: string
          url: string
          width: number | null
        }
        Insert: {
          alt_text?: string | null
          byte_len: number
          c2pa_manifest?: Json | null
          content_type: string
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          object_key: string
          owner_user_id: string
          sha256: string
          storage: string
          url: string
          width?: number | null
        }
        Update: {
          alt_text?: string | null
          byte_len?: number
          c2pa_manifest?: Json | null
          content_type?: string
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          object_key?: string
          owner_user_id?: string
          sha256?: string
          storage?: string
          url?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor: Database["public"]["Enums"]["actor_class"]
          actor_agent_id: string | null
          actor_user_id: string | null
          after_state: Json | null
          at: string
          before_state: Json | null
          delegation_id: string | null
          id: number
          ip_hash: string | null
          request_id: string | null
          target_id: string | null
          target_kind: string | null
        }
        Insert: {
          action: string
          actor: Database["public"]["Enums"]["actor_class"]
          actor_agent_id?: string | null
          actor_user_id?: string | null
          after_state?: Json | null
          at?: string
          before_state?: Json | null
          delegation_id?: string | null
          id?: never
          ip_hash?: string | null
          request_id?: string | null
          target_id?: string | null
          target_kind?: string | null
        }
        Update: {
          action?: string
          actor?: Database["public"]["Enums"]["actor_class"]
          actor_agent_id?: string | null
          actor_user_id?: string | null
          after_state?: Json | null
          at?: string
          before_state?: Json | null
          delegation_id?: string | null
          id?: never
          ip_hash?: string | null
          request_id?: string | null
          target_id?: string | null
          target_kind?: string | null
        }
        Relationships: []
      }
      blocks: {
        Row: {
          blocked_user_id: string
          blocker_user_id: string
          created_at: string
          reason: string | null
        }
        Insert: {
          blocked_user_id: string
          blocker_user_id: string
          created_at?: string
          reason?: string | null
        }
        Update: {
          blocked_user_id?: string
          blocker_user_id?: string
          created_at?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blocks_blocked_user_id_fkey"
            columns: ["blocked_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_blocker_user_id_fkey"
            columns: ["blocker_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      bookmarks: {
        Row: {
          actor_agent_id: string | null
          collection: string | null
          created_at: string
          post_id: string
          user_id: string
        }
        Insert: {
          actor_agent_id?: string | null
          collection?: string | null
          created_at?: string
          post_id: string
          user_id: string
        }
        Update: {
          actor_agent_id?: string | null
          collection?: string | null
          created_at?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookmarks_actor_agent_id_fkey"
            columns: ["actor_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookmarks_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookmarks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          avatar_url: string | null
          connected_at: string
          created_at: string
          credentials_ref: string | null
          disabled_at: string | null
          display_name: string | null
          handle: string | null
          id: string
          last_error: string | null
          owner_user_id: string
          platform: string
          postiz_channel_id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          connected_at?: string
          created_at?: string
          credentials_ref?: string | null
          disabled_at?: string | null
          display_name?: string | null
          handle?: string | null
          id?: string
          last_error?: string | null
          owner_user_id: string
          platform: string
          postiz_channel_id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          connected_at?: string
          created_at?: string
          credentials_ref?: string | null
          disabled_at?: string | null
          display_name?: string | null
          handle?: string | null
          id?: string
          last_error?: string | null
          owner_user_id?: string
          platform?: string
          postiz_channel_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channels_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channels_platform_fkey"
            columns: ["platform"]
            isOneToOne: false
            referencedRelation: "platforms"
            referencedColumns: ["slug"]
          },
        ]
      }
      comments: {
        Row: {
          actor_agent_id: string | null
          author_user_id: string
          body_markdown: string
          content_hash: string
          created_at: string
          deleted_at: string | null
          depth: number
          edited_at: string | null
          id: string
          parent_comment_id: string | null
          post_id: string
          status: Database["public"]["Enums"]["post_status"]
          thread_root_id: string | null
        }
        Insert: {
          actor_agent_id?: string | null
          author_user_id: string
          body_markdown: string
          content_hash: string
          created_at?: string
          deleted_at?: string | null
          depth?: number
          edited_at?: string | null
          id?: string
          parent_comment_id?: string | null
          post_id: string
          status?: Database["public"]["Enums"]["post_status"]
          thread_root_id?: string | null
        }
        Update: {
          actor_agent_id?: string | null
          author_user_id?: string
          body_markdown?: string
          content_hash?: string
          created_at?: string
          deleted_at?: string | null
          depth?: number
          edited_at?: string | null
          id?: string
          parent_comment_id?: string | null
          post_id?: string
          status?: Database["public"]["Enums"]["post_status"]
          thread_root_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comments_actor_agent_id_fkey"
            columns: ["actor_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_author_user_id_fkey"
            columns: ["author_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_thread_root_id_fkey"
            columns: ["thread_root_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
        ]
      }
      connectors: {
        Row: {
          auth_kind: string
          base_url: string | null
          created_at: string
          default_scopes: string[]
          display_name: string
          id: string
          is_enabled: boolean
          is_verified: boolean
          manifest: Json
          slug: string
          transport: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          auth_kind: string
          base_url?: string | null
          created_at?: string
          default_scopes?: string[]
          display_name: string
          id?: string
          is_enabled?: boolean
          is_verified?: boolean
          manifest: Json
          slug: string
          transport: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          auth_kind?: string
          base_url?: string | null
          created_at?: string
          default_scopes?: string[]
          display_name?: string
          id?: string
          is_enabled?: boolean
          is_verified?: boolean
          manifest?: Json
          slug?: string
          transport?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: []
      }
      creator_publishing_defaults: {
        Row: {
          ai_use: boolean
          license_spdx: string
          price_cents: number
          publish_mode: Database["public"]["Enums"]["publish_mode"]
          train_ai: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_use?: boolean
          license_spdx?: string
          price_cents?: number
          publish_mode?: Database["public"]["Enums"]["publish_mode"]
          train_ai?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_use?: boolean
          license_spdx?: string
          price_cents?: number
          publish_mode?: Database["public"]["Enums"]["publish_mode"]
          train_ai?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "creator_publishing_defaults_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      delegation_spend: {
        Row: {
          actions_count: number
          delegation_id: string
          spent_atomic: number
          updated_at: string
          window_start: string
        }
        Insert: {
          actions_count?: number
          delegation_id: string
          spent_atomic?: number
          updated_at?: string
          window_start: string
        }
        Update: {
          actions_count?: number
          delegation_id?: string
          spent_atomic?: number
          updated_at?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "delegation_spend_delegation_id_fkey"
            columns: ["delegation_id"]
            isOneToOne: false
            referencedRelation: "delegations"
            referencedColumns: ["id"]
          },
        ]
      }
      delegations: {
        Row: {
          agent_identity_id: string
          clean_approvals: number
          connector_id: string
          created_at: string
          expires_at: string | null
          first_publish_at: string | null
          generations_per_day: number
          id: string
          last_used_at: string | null
          owner_user_id: string
          per_action_cap_atomic: number
          quarantined_until: string | null
          rate_limit_per_hour: number
          reputation: number
          requires_approval: boolean
          requires_approval_over_atomic: number
          revoked_at: string | null
          scopes: string[]
          spend_cap_atomic: number
          spend_window: string
          state: Database["public"]["Enums"]["delegation_state"]
          strikes: number
          token_sha256: string
        }
        Insert: {
          agent_identity_id: string
          clean_approvals?: number
          connector_id: string
          created_at?: string
          expires_at?: string | null
          first_publish_at?: string | null
          generations_per_day?: number
          id?: string
          last_used_at?: string | null
          owner_user_id: string
          per_action_cap_atomic?: number
          quarantined_until?: string | null
          rate_limit_per_hour?: number
          reputation?: number
          requires_approval?: boolean
          requires_approval_over_atomic?: number
          revoked_at?: string | null
          scopes?: string[]
          spend_cap_atomic?: number
          spend_window?: string
          state?: Database["public"]["Enums"]["delegation_state"]
          strikes?: number
          token_sha256: string
        }
        Update: {
          agent_identity_id?: string
          clean_approvals?: number
          connector_id?: string
          created_at?: string
          expires_at?: string | null
          first_publish_at?: string | null
          generations_per_day?: number
          id?: string
          last_used_at?: string | null
          owner_user_id?: string
          per_action_cap_atomic?: number
          quarantined_until?: string | null
          rate_limit_per_hour?: number
          reputation?: number
          requires_approval?: boolean
          requires_approval_over_atomic?: number
          revoked_at?: string | null
          scopes?: string[]
          spend_cap_atomic?: number
          spend_window?: string
          state?: Database["public"]["Enums"]["delegation_state"]
          strikes?: number
          token_sha256?: string
        }
        Relationships: [
          {
            foreignKeyName: "delegations_agent_identity_id_fkey"
            columns: ["agent_identity_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delegations_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delegations_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      distribution_jobs: {
        Row: {
          attempts: number
          channel_id: string
          created_at: string
          id: string
          idempotency_key: string
          last_error: string | null
          platform_post_id: string | null
          platform_post_url: string | null
          post_id: string
          post_version_id: string
          postiz_post_id: string | null
          request_payload: Json | null
          response_payload: Json | null
          scheduled_for: string | null
          state: Database["public"]["Enums"]["job_state"]
          updated_at: string
          variant_id: string | null
        }
        Insert: {
          attempts?: number
          channel_id: string
          created_at?: string
          id?: string
          idempotency_key: string
          last_error?: string | null
          platform_post_id?: string | null
          platform_post_url?: string | null
          post_id: string
          post_version_id: string
          postiz_post_id?: string | null
          request_payload?: Json | null
          response_payload?: Json | null
          scheduled_for?: string | null
          state?: Database["public"]["Enums"]["job_state"]
          updated_at?: string
          variant_id?: string | null
        }
        Update: {
          attempts?: number
          channel_id?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          last_error?: string | null
          platform_post_id?: string | null
          platform_post_url?: string | null
          post_id?: string
          post_version_id?: string
          postiz_post_id?: string | null
          request_payload?: Json | null
          response_payload?: Json | null
          scheduled_for?: string | null
          state?: Database["public"]["Enums"]["job_state"]
          updated_at?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "distribution_jobs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "distribution_jobs_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "distribution_jobs_post_version_id_fkey"
            columns: ["post_version_id"]
            isOneToOne: false
            referencedRelation: "post_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "distribution_jobs_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "platform_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      follows: {
        Row: {
          actor_agent_id: string | null
          created_at: string
          followee_user_id: string | null
          follower_user_id: string
          id: string
          target_kind: string
          topic_id: string | null
        }
        Insert: {
          actor_agent_id?: string | null
          created_at?: string
          followee_user_id?: string | null
          follower_user_id: string
          id?: string
          target_kind?: string
          topic_id?: string | null
        }
        Update: {
          actor_agent_id?: string | null
          created_at?: string
          followee_user_id?: string | null
          follower_user_id?: string
          id?: string
          target_kind?: string
          topic_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "follows_actor_agent_id_fkey"
            columns: ["actor_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_followee_user_id_fkey"
            columns: ["followee_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_follower_user_id_fkey"
            columns: ["follower_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          actor: string
          created_at: string
          endpoint: string
          expires_at: string
          id: string
          idempotency_key: string
          request_sha256: string | null
          response_body: Json | null
          response_status: number | null
          state: string
        }
        Insert: {
          actor: string
          created_at?: string
          endpoint: string
          expires_at?: string
          id?: string
          idempotency_key: string
          request_sha256?: string | null
          response_body?: Json | null
          response_status?: number | null
          state?: string
        }
        Update: {
          actor?: string
          created_at?: string
          endpoint?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          request_sha256?: string | null
          response_body?: Json | null
          response_status?: number | null
          state?: string
        }
        Relationships: []
      }
      job_outbox: {
        Row: {
          attempts: number
          claimed_at: string | null
          created_at: string
          dedupe_key: string
          done_at: string | null
          enqueued_at: string | null
          id: number
          kind: string
          last_error: string | null
          payload: Json
          state: Database["public"]["Enums"]["job_state"]
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          dedupe_key: string
          done_at?: string | null
          enqueued_at?: string | null
          id?: never
          kind: string
          last_error?: string | null
          payload: Json
          state?: Database["public"]["Enums"]["job_state"]
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          dedupe_key?: string
          done_at?: string | null
          enqueued_at?: string | null
          id?: never
          kind?: string
          last_error?: string | null
          payload?: Json
          state?: Database["public"]["Enums"]["job_state"]
        }
        Relationships: []
      }
      likes: {
        Row: {
          actor_agent_id: string | null
          created_at: string
          post_id: string
          user_id: string
        }
        Insert: {
          actor_agent_id?: string | null
          created_at?: string
          post_id: string
          user_id: string
        }
        Update: {
          actor_agent_id?: string | null
          created_at?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "likes_actor_agent_id_fkey"
            columns: ["actor_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "likes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      model_registry: {
        Row: {
          artifact_url: string | null
          created_at: string
          family: string
          input_dim: number | null
          metrics: Json
          model_version: string
          status: string
          trained_at: string | null
        }
        Insert: {
          artifact_url?: string | null
          created_at?: string
          family: string
          input_dim?: number | null
          metrics?: Json
          model_version: string
          status?: string
          trained_at?: string | null
        }
        Update: {
          artifact_url?: string | null
          created_at?: string
          family?: string
          input_dim?: number | null
          metrics?: Json
          model_version?: string
          status?: string
          trained_at?: string | null
        }
        Relationships: []
      }
      mutes: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          muted_keyword: string | null
          muted_user_id: string | null
          muter_user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          muted_keyword?: string | null
          muted_user_id?: string | null
          muter_user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          muted_keyword?: string | null
          muted_user_id?: string | null
          muter_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mutes_muted_user_id_fkey"
            columns: ["muted_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mutes_muter_user_id_fkey"
            columns: ["muter_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_events: {
        Row: {
          at: string
          component: string
          event_name: string
          id: number
          level: string
          metadata: Json
          outcome: string | null
          request_id: string | null
        }
        Insert: {
          at?: string
          component: string
          event_name: string
          id?: never
          level?: string
          metadata?: Json
          outcome?: string | null
          request_id?: string | null
        }
        Update: {
          at?: string
          component?: string
          event_name?: string
          id?: never
          level?: string
          metadata?: Json
          outcome?: string | null
          request_id?: string | null
        }
        Relationships: []
      }
      payout_ledger: {
        Row: {
          account_address: string | null
          account_kind: string
          account_user_id: string | null
          amount_atomic: number
          asset: string
          created_at: string
          id: string
          ledger_tx_id: string
          memo: string | null
          network: string
          refund_id: string | null
          settlement_id: string | null
        }
        Insert: {
          account_address?: string | null
          account_kind: string
          account_user_id?: string | null
          amount_atomic: number
          asset: string
          created_at?: string
          id?: string
          ledger_tx_id: string
          memo?: string | null
          network: string
          refund_id?: string | null
          settlement_id?: string | null
        }
        Update: {
          account_address?: string | null
          account_kind?: string
          account_user_id?: string | null
          amount_atomic?: number
          asset?: string
          created_at?: string
          id?: string
          ledger_tx_id?: string
          memo?: string | null
          network?: string
          refund_id?: string | null
          settlement_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payout_ledger_account_user_id_fkey"
            columns: ["account_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_ledger_refund_fk"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refunds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_ledger_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "x402_settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_analytics: {
        Row: {
          channel_id: string
          clicks: number
          collected_at: string
          collected_for: string
          comments: number
          id: string
          impressions: number
          likes: number
          platform_post_id: string
          post_id: string | null
          raw: Json
          shares: number
        }
        Insert: {
          channel_id: string
          clicks?: number
          collected_at?: string
          collected_for: string
          comments?: number
          id?: string
          impressions?: number
          likes?: number
          platform_post_id: string
          post_id?: string | null
          raw?: Json
          shares?: number
        }
        Update: {
          channel_id?: string
          clicks?: number
          collected_at?: string
          collected_for?: string
          comments?: number
          id?: string
          impressions?: number
          likes?: number
          platform_post_id?: string
          post_id?: string | null
          raw?: Json
          shares?: number
        }
        Relationships: [
          {
            foreignKeyName: "platform_analytics_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_analytics_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_publishing_defaults: {
        Row: {
          crawl_price_atomic: number
          id: boolean
          price_asset: string
          price_network: string
          read_price_atomic: number
          updated_at: string
        }
        Insert: {
          crawl_price_atomic?: number
          id?: boolean
          price_asset: string
          price_network?: string
          read_price_atomic?: number
          updated_at?: string
        }
        Update: {
          crawl_price_atomic?: number
          id?: boolean
          price_asset?: string
          price_network?: string
          read_price_atomic?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_variants: {
        Row: {
          approved_at: string | null
          body: string
          created_at: string
          generated_by: string
          id: string
          is_valid: boolean
          media: Json
          platform: string
          post_id: string
          post_version_id: string
          thread_parts: Json | null
          validator_report: Json
        }
        Insert: {
          approved_at?: string | null
          body: string
          created_at?: string
          generated_by?: string
          id?: string
          is_valid?: boolean
          media?: Json
          platform: string
          post_id: string
          post_version_id: string
          thread_parts?: Json | null
          validator_report?: Json
        }
        Update: {
          approved_at?: string | null
          body?: string
          created_at?: string
          generated_by?: string
          id?: string
          is_valid?: boolean
          media?: Json
          platform?: string
          post_id?: string
          post_version_id?: string
          thread_parts?: Json | null
          validator_report?: Json
        }
        Relationships: [
          {
            foreignKeyName: "platform_variants_platform_fkey"
            columns: ["platform"]
            isOneToOne: false
            referencedRelation: "platforms"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "platform_variants_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_variants_post_version_id_fkey"
            columns: ["post_version_id"]
            isOneToOne: false
            referencedRelation: "post_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      platforms: {
        Row: {
          aspect_ratios: Json
          display_name: string
          max_alt_chars: number | null
          max_chars: number | null
          max_images: number
          max_video_seconds: number | null
          notes: string | null
          slug: string
          supports_alt_text: boolean
          supports_link_preview: boolean
          supports_threads: boolean
          updated_at: string
          url_counts_as_chars: number | null
        }
        Insert: {
          aspect_ratios?: Json
          display_name: string
          max_alt_chars?: number | null
          max_chars?: number | null
          max_images?: number
          max_video_seconds?: number | null
          notes?: string | null
          slug: string
          supports_alt_text?: boolean
          supports_link_preview?: boolean
          supports_threads?: boolean
          updated_at?: string
          url_counts_as_chars?: number | null
        }
        Update: {
          aspect_ratios?: Json
          display_name?: string
          max_alt_chars?: number | null
          max_chars?: number | null
          max_images?: number
          max_video_seconds?: number | null
          notes?: string | null
          slug?: string
          supports_alt_text?: boolean
          supports_link_preview?: boolean
          supports_threads?: boolean
          updated_at?: string
          url_counts_as_chars?: number | null
        }
        Relationships: []
      }
      post_assets: {
        Row: {
          asset_id: string
          position: number
          post_id: string
        }
        Insert: {
          asset_id: string
          position?: number
          post_id: string
        }
        Update: {
          asset_id?: string
          position?: number
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_assets_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_assets_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_bodies: {
        Row: {
          byte_len: number
          canonical_markdown: string
          content_hash: string
          created_at: string
        }
        Insert: {
          byte_len: number
          canonical_markdown: string
          content_hash: string
          created_at?: string
        }
        Update: {
          byte_len?: number
          canonical_markdown?: string
          content_hash?: string
          created_at?: string
        }
        Relationships: []
      }
      post_classifications: {
        Row: {
          classified_at: string
          commercial_intent: number | null
          content_hash: string
          is_ai_generated: boolean | null
          is_nsfw: boolean
          language_code: string | null
          latency_ms: number | null
          model: string
          primary_topic: string | null
          provider: string
          quality: number | null
          spam: number | null
          topics: string[]
          toxicity: number | null
        }
        Insert: {
          classified_at?: string
          commercial_intent?: number | null
          content_hash: string
          is_ai_generated?: boolean | null
          is_nsfw?: boolean
          language_code?: string | null
          latency_ms?: number | null
          model: string
          primary_topic?: string | null
          provider?: string
          quality?: number | null
          spam?: number | null
          topics?: string[]
          toxicity?: number | null
        }
        Update: {
          classified_at?: string
          commercial_intent?: number | null
          content_hash?: string
          is_ai_generated?: boolean | null
          is_nsfw?: boolean
          language_code?: string | null
          latency_ms?: number | null
          model?: string
          primary_topic?: string | null
          provider?: string
          quality?: number | null
          spam?: number | null
          topics?: string[]
          toxicity?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "post_classifications_content_hash_fkey"
            columns: ["content_hash"]
            isOneToOne: true
            referencedRelation: "post_bodies"
            referencedColumns: ["content_hash"]
          },
        ]
      }
      post_classifications_raw: {
        Row: {
          content_hash: string
          created_at: string
          provider: string
          raw: Json
          request_id: string | null
        }
        Insert: {
          content_hash: string
          created_at?: string
          provider: string
          raw: Json
          request_id?: string | null
        }
        Update: {
          content_hash?: string
          created_at?: string
          provider?: string
          raw?: Json
          request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "post_classifications_raw_content_hash_fkey"
            columns: ["content_hash"]
            isOneToOne: true
            referencedRelation: "post_bodies"
            referencedColumns: ["content_hash"]
          },
        ]
      }
      post_counters: {
        Row: {
          bookmarks: number
          comments: number
          dwell_ms_total: number
          impressions: number
          likes: number
          opens: number
          paid_fetches: number
          post_id: string
          reposts: number
          updated_at: string
        }
        Insert: {
          bookmarks?: number
          comments?: number
          dwell_ms_total?: number
          impressions?: number
          likes?: number
          opens?: number
          paid_fetches?: number
          post_id: string
          reposts?: number
          updated_at?: string
        }
        Update: {
          bookmarks?: number
          comments?: number
          dwell_ms_total?: number
          impressions?: number
          likes?: number
          opens?: number
          paid_fetches?: number
          post_id?: string
          reposts?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_counters_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: true
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_embeddings: {
        Row: {
          content_hash: string
          created_at: string
          dim: number
          embedding: string
          model: string
          post_id: string
        }
        Insert: {
          content_hash: string
          created_at?: string
          dim?: number
          embedding: string
          model?: string
          post_id: string
        }
        Update: {
          content_hash?: string
          created_at?: string
          dim?: number
          embedding?: string
          model?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_embeddings_content_hash_fkey"
            columns: ["content_hash"]
            isOneToOne: true
            referencedRelation: "post_bodies"
            referencedColumns: ["content_hash"]
          },
          {
            foreignKeyName: "post_embeddings_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_versions: {
        Row: {
          change_note: string | null
          content_hash: string
          created_at: string
          editor_agent_id: string | null
          editor_user_id: string | null
          id: string
          post_id: string
          summary: string | null
          title: string | null
          version: number
        }
        Insert: {
          change_note?: string | null
          content_hash: string
          created_at?: string
          editor_agent_id?: string | null
          editor_user_id?: string | null
          id?: string
          post_id: string
          summary?: string | null
          title?: string | null
          version: number
        }
        Update: {
          change_note?: string | null
          content_hash?: string
          created_at?: string
          editor_agent_id?: string | null
          editor_user_id?: string | null
          id?: string
          post_id?: string
          summary?: string | null
          title?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_versions_content_hash_fkey"
            columns: ["content_hash"]
            isOneToOne: false
            referencedRelation: "post_bodies"
            referencedColumns: ["content_hash"]
          },
          {
            foreignKeyName: "post_versions_editor_agent_id_fkey"
            columns: ["editor_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_versions_editor_user_id_fkey"
            columns: ["editor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_versions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          ai_use: boolean
          attribution_required: boolean
          author_user_id: string
          canonical_url: string | null
          citation_template: string | null
          content_hash: string
          created_at: string
          current_version: number
          deleted_at: string | null
          id: string
          kind: Database["public"]["Enums"]["post_kind"]
          language_code: string
          license_spdx: string
          license_url: string | null
          og_image_url: string | null
          parent_post_id: string | null
          posted_by_agent_id: string | null
          price_asset: string | null
          price_atomic: number
          price_network: string | null
          publish_mode: Database["public"]["Enums"]["publish_mode"]
          published_at: string | null
          scheduled_for: string | null
          search_indexable: boolean
          search_tsv: unknown
          slug: string
          status: Database["public"]["Enums"]["post_status"]
          summary: string | null
          tags: string[]
          title: string | null
          train_ai: boolean
          updated_at: string
        }
        Insert: {
          ai_use?: boolean
          attribution_required?: boolean
          author_user_id: string
          canonical_url?: string | null
          citation_template?: string | null
          content_hash: string
          created_at?: string
          current_version?: number
          deleted_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["post_kind"]
          language_code?: string
          license_spdx?: string
          license_url?: string | null
          og_image_url?: string | null
          parent_post_id?: string | null
          posted_by_agent_id?: string | null
          price_asset?: string | null
          price_atomic?: number
          price_network?: string | null
          publish_mode?: Database["public"]["Enums"]["publish_mode"]
          published_at?: string | null
          scheduled_for?: string | null
          search_indexable?: boolean
          search_tsv?: unknown
          slug: string
          status?: Database["public"]["Enums"]["post_status"]
          summary?: string | null
          tags?: string[]
          title?: string | null
          train_ai?: boolean
          updated_at?: string
        }
        Update: {
          ai_use?: boolean
          attribution_required?: boolean
          author_user_id?: string
          canonical_url?: string | null
          citation_template?: string | null
          content_hash?: string
          created_at?: string
          current_version?: number
          deleted_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["post_kind"]
          language_code?: string
          license_spdx?: string
          license_url?: string | null
          og_image_url?: string | null
          parent_post_id?: string | null
          posted_by_agent_id?: string | null
          price_asset?: string | null
          price_atomic?: number
          price_network?: string | null
          publish_mode?: Database["public"]["Enums"]["publish_mode"]
          published_at?: string | null
          scheduled_for?: string | null
          search_indexable?: boolean
          search_tsv?: unknown
          slug?: string
          status?: Database["public"]["Enums"]["post_status"]
          summary?: string | null
          tags?: string[]
          title?: string | null
          train_ai?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_user_id_fkey"
            columns: ["author_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_content_hash_fkey"
            columns: ["content_hash"]
            isOneToOne: false
            referencedRelation: "post_bodies"
            referencedColumns: ["content_hash"]
          },
          {
            foreignKeyName: "posts_parent_post_id_fkey"
            columns: ["parent_post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_posted_by_agent_id_fkey"
            columns: ["posted_by_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          banner_url: string | null
          bio: string | null
          created_at: string
          display_name: string | null
          handle: string
          is_verified: boolean
          updated_at: string
          user_id: string
          website_url: string | null
        }
        Insert: {
          avatar_url?: string | null
          banner_url?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string | null
          handle: string
          is_verified?: boolean
          updated_at?: string
          user_id: string
          website_url?: string | null
        }
        Update: {
          avatar_url?: string | null
          banner_url?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string | null
          handle?: string
          is_verified?: boolean
          updated_at?: string
          user_id?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranking_weights: {
        Row: {
          activated_at: string | null
          cohort: string
          created_at: string
          is_active: boolean
          notes: string | null
          weights: Json
          weights_version: string
        }
        Insert: {
          activated_at?: string | null
          cohort?: string
          created_at?: string
          is_active?: boolean
          notes?: string | null
          weights: Json
          weights_version: string
        }
        Update: {
          activated_at?: string | null
          cohort?: string
          created_at?: string
          is_active?: boolean
          notes?: string | null
          weights?: Json
          weights_version?: string
        }
        Relationships: []
      }
      refunds: {
        Row: {
          amount_atomic: number
          completed_at: string | null
          created_at: string
          id: string
          initiated_by_user_id: string | null
          reason: string
          settlement_id: string
          status: Database["public"]["Enums"]["settlement_status"]
          transaction: string
        }
        Insert: {
          amount_atomic: number
          completed_at?: string | null
          created_at?: string
          id?: string
          initiated_by_user_id?: string | null
          reason: string
          settlement_id: string
          status?: Database["public"]["Enums"]["settlement_status"]
          transaction?: string
        }
        Update: {
          amount_atomic?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          initiated_by_user_id?: string | null
          reason?: string
          settlement_id?: string
          status?: Database["public"]["Enums"]["settlement_status"]
          transaction?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_initiated_by_user_id_fkey"
            columns: ["initiated_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "x402_settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      reposts: {
        Row: {
          actor_agent_id: string | null
          created_at: string
          id: string
          post_id: string
          quote_body: string | null
          user_id: string
        }
        Insert: {
          actor_agent_id?: string | null
          created_at?: string
          id?: string
          post_id: string
          quote_body?: string | null
          user_id: string
        }
        Update: {
          actor_agent_id?: string | null
          created_at?: string
          id?: string
          post_id?: string
          quote_body?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reposts_actor_agent_id_fkey"
            columns: ["actor_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reposts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reposts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      scopes: {
        Row: {
          created_at: string
          description: string
          is_grantable: boolean
          is_spend_bearing: boolean
          requires_approval_default: boolean
          scope: string
        }
        Insert: {
          created_at?: string
          description: string
          is_grantable?: boolean
          is_spend_bearing?: boolean
          requires_approval_default?: boolean
          scope: string
        }
        Update: {
          created_at?: string
          description?: string
          is_grantable?: boolean
          is_spend_bearing?: boolean
          requires_approval_default?: boolean
          scope?: string
        }
        Relationships: []
      }
      sessions: {
        Row: {
          actor: Database["public"]["Enums"]["actor_class"]
          expires_at: string
          id: string
          ip_hash: string | null
          issued_at: string
          last_seen_at: string | null
          revoked_at: string | null
          token_sha256: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          actor: Database["public"]["Enums"]["actor_class"]
          expires_at: string
          id?: string
          ip_hash?: string | null
          issued_at?: string
          last_seen_at?: string | null
          revoked_at?: string | null
          token_sha256: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          actor?: Database["public"]["Enums"]["actor_class"]
          expires_at?: string
          id?: string
          ip_hash?: string | null
          issued_at?: string
          last_seen_at?: string | null
          revoked_at?: string | null
          token_sha256?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      slate_items: {
        Row: {
          action_scores: Json
          position: number
          post_id: string
          score: number | null
          slate_id: string
          source: string
          weighted_score: number | null
        }
        Insert: {
          action_scores?: Json
          position: number
          post_id: string
          score?: number | null
          slate_id: string
          source: string
          weighted_score?: number | null
        }
        Update: {
          action_scores?: Json
          position?: number
          post_id?: string
          score?: number | null
          slate_id?: string
          source?: string
          weighted_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "slate_items_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slate_items_slate_id_fkey"
            columns: ["slate_id"]
            isOneToOne: false
            referencedRelation: "slates"
            referencedColumns: ["id"]
          },
        ]
      }
      slates: {
        Row: {
          candidate_count: number
          created_at: string
          expires_at: string
          id: string
          model_version: string
          params: Json
          surface: string
          viewer_agent_id: string | null
          viewer_user_id: string | null
          weights_version: string
        }
        Insert: {
          candidate_count?: number
          created_at?: string
          expires_at?: string
          id?: string
          model_version: string
          params?: Json
          surface: string
          viewer_agent_id?: string | null
          viewer_user_id?: string | null
          weights_version: string
        }
        Update: {
          candidate_count?: number
          created_at?: string
          expires_at?: string
          id?: string
          model_version?: string
          params?: Json
          surface?: string
          viewer_agent_id?: string | null
          viewer_user_id?: string | null
          weights_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "slates_model_version_fkey"
            columns: ["model_version"]
            isOneToOne: false
            referencedRelation: "model_registry"
            referencedColumns: ["model_version"]
          },
          {
            foreignKeyName: "slates_viewer_agent_id_fkey"
            columns: ["viewer_agent_id"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slates_viewer_user_id_fkey"
            columns: ["viewer_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slates_weights_version_fkey"
            columns: ["weights_version"]
            isOneToOne: false
            referencedRelation: "ranking_weights"
            referencedColumns: ["weights_version"]
          },
        ]
      }
      user_embeddings: {
        Row: {
          embedding: string
          model: string
          n_events: number
          updated_at: string
          user_id: string
        }
        Insert: {
          embedding: string
          model?: string
          n_events?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          embedding?: string
          model?: string
          n_events?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_embeddings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          analytics_consent: boolean
          country_code: string | null
          created_at: string
          deleted_at: string | null
          email: string | null
          email_verified_at: string | null
          id: string
          is_suspended: boolean
          marketing_consent: boolean
          tos_accepted_at: string | null
          updated_at: string
        }
        Insert: {
          analytics_consent?: boolean
          country_code?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          email_verified_at?: string | null
          id?: string
          is_suspended?: boolean
          marketing_consent?: boolean
          tos_accepted_at?: string | null
          updated_at?: string
        }
        Update: {
          analytics_consent?: boolean
          country_code?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          email_verified_at?: string | null
          id?: string
          is_suspended?: boolean
          marketing_consent?: boolean
          tos_accepted_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      wallet_nonces: {
        Row: {
          action: string
          address: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          message: string
          nonce: string
        }
        Insert: {
          action: string
          address: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          message: string
          nonce: string
        }
        Update: {
          action?: string
          address?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          message?: string
          nonce?: string
        }
        Relationships: []
      }
      wallets: {
        Row: {
          address: string
          created_at: string
          id: string
          is_primary: boolean
          user_id: string
          verified_at: string | null
        }
        Insert: {
          address: string
          created_at?: string
          id?: string
          is_primary?: boolean
          user_id: string
          verified_at?: string | null
        }
        Update: {
          address?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wallets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      x402_quotes: {
        Row: {
          amount_atomic: number
          asset: string
          consumed_at: string | null
          content_hash: string
          expires_at: string
          id: string
          issued_at: string
          max_timeout_seconds: number
          network: string
          pay_to: string
          post_id: string | null
          rate_source: string
          requested_by_agent: string | null
          requirements: Json
          resource_url: string
          scheme: string
          transport: string
          x402_version: number
        }
        Insert: {
          amount_atomic: number
          asset: string
          consumed_at?: string | null
          content_hash: string
          expires_at: string
          id?: string
          issued_at?: string
          max_timeout_seconds?: number
          network: string
          pay_to: string
          post_id?: string | null
          rate_source?: string
          requested_by_agent?: string | null
          requirements: Json
          resource_url: string
          scheme?: string
          transport?: string
          x402_version?: number
        }
        Update: {
          amount_atomic?: number
          asset?: string
          consumed_at?: string | null
          content_hash?: string
          expires_at?: string
          id?: string
          issued_at?: string
          max_timeout_seconds?: number
          network?: string
          pay_to?: string
          post_id?: string | null
          rate_source?: string
          requested_by_agent?: string | null
          requirements?: Json
          resource_url?: string
          scheme?: string
          transport?: string
          x402_version?: number
        }
        Relationships: [
          {
            foreignKeyName: "x402_quotes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "x402_quotes_requested_by_agent_fkey"
            columns: ["requested_by_agent"]
            isOneToOne: false
            referencedRelation: "agent_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      x402_settlements: {
        Row: {
          amount_atomic: number
          asset: string
          content_hash: string
          created_at: string
          error_reason: string | null
          facilitator_url: string
          id: string
          network: string
          nonce: string
          pay_to: string
          payer: string
          post_id: string | null
          quote_id: string | null
          settle_response: Json | null
          settled_at: string | null
          status: Database["public"]["Enums"]["settlement_status"]
          transaction: string
          verify_response: Json | null
        }
        Insert: {
          amount_atomic: number
          asset: string
          content_hash: string
          created_at?: string
          error_reason?: string | null
          facilitator_url: string
          id?: string
          network: string
          nonce: string
          pay_to: string
          payer: string
          post_id?: string | null
          quote_id?: string | null
          settle_response?: Json | null
          settled_at?: string | null
          status?: Database["public"]["Enums"]["settlement_status"]
          transaction?: string
          verify_response?: Json | null
        }
        Update: {
          amount_atomic?: number
          asset?: string
          content_hash?: string
          created_at?: string
          error_reason?: string | null
          facilitator_url?: string
          id?: string
          network?: string
          nonce?: string
          pay_to?: string
          payer?: string
          post_id?: string | null
          quote_id?: string | null
          settle_response?: Json | null
          settled_at?: string | null
          status?: Database["public"]["Enums"]["settlement_status"]
          transaction?: string
          verify_response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "x402_settlements_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "x402_settlements_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "x402_quotes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      adjust_post_counter: {
        Args: { p_delta: number; p_metric: string; p_post_id: string }
        Returns: undefined
      }
      claim_job: {
        Args: { p_job_id: number }
        Returns: {
          attempts: number
          kind: string
          payload: Json
        }[]
      }
      link_wallet_identity: {
        Args: { p_address: string; p_chain_id?: number }
        Returns: {
          created: boolean
          handle: string
          user_id: string
        }[]
      }
      publish_post: {
        Args: { p_platforms?: string[]; p_post_id: string }
        Returns: {
          job_ids: number[]
          post_id: string
        }[]
      }
    }
    Enums: {
      action_kind:
        | "impression"
        | "view"
        | "dwell"
        | "play"
        | "play_through"
        | "like"
        | "comment"
        | "repost"
        | "bookmark"
        | "share"
        | "follow"
        | "remix"
        | "fork_app"
        | "install_app"
        | "tip"
        | "x402_pay"
        | "agent_crawl"
        | "agent_cite"
        | "not_interested"
        | "mute_creator"
        | "block_creator"
        | "report"
        | "not_dwelled"
      actor_class:
        | "human_creator"
        | "human_reader"
        | "owner_agent"
        | "crawler_agent"
      actor_plane: "human" | "agent"
      agent_verification:
        | "none"
        | "web_bot_auth"
        | "verified_crawler"
        | "owner_delegated"
        | "moltbook"
      approval_state: "pending" | "approved" | "rejected" | "expired"
      delegation_state: "active" | "paused" | "revoked" | "expired"
      job_state: "queued" | "running" | "succeeded" | "failed" | "dead"
      post_kind:
        | "note"
        | "article"
        | "image"
        | "video"
        | "audio"
        | "app"
        | "model3d"
        | "thread"
      post_status:
        | "draft"
        | "pending_approval"
        | "scheduled"
        | "published"
        | "unlisted"
        | "removed"
      publish_mode: "free" | "human_free_agent_paid" | "x402_always"
      settlement_status: "pending" | "settled" | "failed" | "refunded"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      action_kind: [
        "impression",
        "view",
        "dwell",
        "play",
        "play_through",
        "like",
        "comment",
        "repost",
        "bookmark",
        "share",
        "follow",
        "remix",
        "fork_app",
        "install_app",
        "tip",
        "x402_pay",
        "agent_crawl",
        "agent_cite",
        "not_interested",
        "mute_creator",
        "block_creator",
        "report",
        "not_dwelled",
      ],
      actor_class: [
        "human_creator",
        "human_reader",
        "owner_agent",
        "crawler_agent",
      ],
      actor_plane: ["human", "agent"],
      agent_verification: [
        "none",
        "web_bot_auth",
        "verified_crawler",
        "owner_delegated",
        "moltbook",
      ],
      approval_state: ["pending", "approved", "rejected", "expired"],
      delegation_state: ["active", "paused", "revoked", "expired"],
      job_state: ["queued", "running", "succeeded", "failed", "dead"],
      post_kind: [
        "note",
        "article",
        "image",
        "video",
        "audio",
        "app",
        "model3d",
        "thread",
      ],
      post_status: [
        "draft",
        "pending_approval",
        "scheduled",
        "published",
        "unlisted",
        "removed",
      ],
      publish_mode: ["free", "human_free_agent_paid", "x402_always"],
      settlement_status: ["pending", "settled", "failed", "refunded"],
    },
  },
} as const

