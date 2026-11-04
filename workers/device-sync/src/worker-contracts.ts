/** A row returned by direct SQL; callers should add a query-specific shape when possible. */
export type SqlRow = Record<string, any>;

interface WorkerD1PreparedStatement extends Omit<D1PreparedStatement, "bind" | "first" | "all"> {
  bind(...values: unknown[]): WorkerD1PreparedStatement;
  first<T = SqlRow>(columnName?: string): Promise<T | null>;
  all<T = SqlRow>(): Promise<D1Result<T>>;
}

interface WorkerD1Database extends Omit<D1Database, "prepare"> {
  prepare(query: string): WorkerD1PreparedStatement;
}

/** Cloudflare bindings generated from the management Worker configuration. */
export type WorkerEnvironment = Omit<ManagementBindings, "DB"> & {
  DB: WorkerD1Database;
  ADMIN_ALLOWED_EMAILS?: string;
  OPENROUTER_API_KEY?: string;
};

/** Runtime context passed to a Worker request handler. */
export type WorkerExecutionContext = ExecutionContext;

/** Event types used by the Worker's queue and scheduled handlers. */
export type CaptureQueueBatch = MessageBatch<{ job_id?: unknown }>;
export type WorkerScheduledController = ScheduledController;

export interface DeviceCredentialRow {
  device_id: string;
  token_hash: string;
  public_key: string | null;
  enabled: number;
}

export interface EnrollmentRow {
  code_hash: string;
  expires_at: number;
  consumed_at: number | null;
}

export interface EnrollmentRequestRow {
  request_id: string;
  device_id: string;
  public_key: string;
  fingerprint: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  status: "pending" | "approved" | "rejected";
}

export interface ActivePlaylistRow {
  playlist_id: string;
  revision: string;
  rotation_interval: number;
  has_captures: number;
}

export interface PlaylistAssetRow {
  position: number;
  sha256: string;
  size: number;
}

export interface AssignedAssetRow {
  size: number;
}
