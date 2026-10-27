import type { ComputedMetrics, RawEvent } from './assessment';

export interface UserPreferences {
  audio_enabled: boolean;
  haptic_enabled: boolean;
  reminder_frequency: 'daily' | 'every_2_days' | 'weekly' | 'off';
}

export interface TugStepCalibration {
  placement?: 'front_trouser_pocket'; // absent on legacy chest calibrations
  template: number[];              // normalized mean W template (zero-mean, unit-norm)
  template_dt_ms: number;          // sample spacing of template
  correlation_floor: number;       // runtime correlation must exceed this to count as a step
  n_steps_used: number;            // total W windows averaged
  n_batches: number;               // number of 5-step batches collected
  final_delta: number | null;      // template L2 change between last two batches; null on N=1
  avg_stride_length_m: number;     // mean Weinberg stride length across calibration steps
  avg_step_time_ms: number;        // mean inter-W interval across accepted W's; with stride gives gait speed
  detection_rate_history: number[]; // per-batch accepted-W's / expected-W's; trend metric
  calibrated_at: string;
  app_version: string;
}

export interface UserProfile {
  id: 'current';
  participant_id: string;
  name: string;
  date_of_birth?: string;
  consent_date: string;
  consent_version: string;
  preferences: UserPreferences;
  tug_step_calibration?: TugStepCalibration;
  clock_offset?: number;
  schema_version?: number;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
  first_assessment_completed?: boolean;
  install_prompt_dismissed_at?: string;
  practice_completed?: boolean;
}

export interface SessionMetadata {
  hand_used: 'left' | 'right' | 'n/a';
  fatigue_rating: number | null;
  medication_taken: boolean | null;
  hand_weakness?: 'none' | 'mild' | 'moderate' | 'severe' | null;
  screen_width_px: number;
  screen_height_px: number;
  target_radius_px: number;
  device_os: string;
  browser: string;
  app_version: string;
  walking_aid?: 'none' | 'cane' | 'walker' | 'other';

  // TUG-specific trial mechanics
  cue_distance_m?: number;
  end_trigger?: 'stillness' | 'sitdown_timeout' | 'manual' | 'safety_timeout';

  // TUG-specific calibration snapshot (copy of UserProfile.tug_step_calibration
  // at trial start so each row knows which calibration produced it).
  calibration_snapshot?: TugCalibrationSnapshot;
}

export interface TugCalibrationSnapshot {
  calibrated_at: string;
  app_version: string;
  n_steps_used: number;
  correlation_floor: number;
  avg_stride_length_m: number;
  avg_step_time_ms: number;
  template: string;                // JSON-encoded number[] — stringified at snapshot time so the field map can send it as text
  template_dt_ms: number;
}

export interface AssessmentResult {
  local_uuid: string;
  participant_id: string;
  timestamp_start: string;
  task_type: string;
  status: 'in_progress' | 'complete' | 'flagged' | 'discarded';
  session_metadata: SessionMetadata;
  raw_data: RawEvent[];
  computed_metrics: ComputedMetrics;
  flagged: boolean;
  flag_reason: string | null;
  synced: boolean;
  sync_attempts: number;
  checksum: string;
  session_group_id?: string;
}

export interface SyncQueueEntry {
  id?: number;
  type: 'upload_data';
  payload: Record<string, unknown>;
  local_uuid: string | null;
  status: 'pending' | 'in_flight' | 'failed' | 'completed';
  attempts: number;
  max_attempts: number;
  created_at: string;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  error: string | null;
}

export interface AuditLogEntry {
  id?: number;
  timestamp: string;
  action:
    | 'assessment_started'
    | 'assessment_completed'
    | 'assessment_flagged'
    | 'sync_success'
    | 'sync_failed'
    | 'profile_created'
    | 'profile_updated'
    | 'consent_given'
    | 'data_exported'
    | 'account_signed_out'
    | 'data_deleted'
    | 'tug_step_calibration_saved';
  entity_id: string | null;
  details: Record<string, unknown>;
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt: string | null;
  error: string | null;
}
