import type { WorkerEnvironment } from "./worker-contracts.ts";

export function auditStatement(
  env: WorkerEnvironment,
  actorID: string,
  eventType: string,
  subjectType: string,
  subjectID: string,
  metadata: unknown,
  { onlyWhenPreviousChanged = false }: { onlyWhenPreviousChanged?: boolean } = {},
): D1PreparedStatement {
  const insert = onlyWhenPreviousChanged
    ? "SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0"
    : "VALUES (?, ?, ?, ?, ?, ?, ?)";
  return env.DB.prepare(
    "INSERT INTO audit_events (event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json) " +
    insert,
  ).bind(crypto.randomUUID(), actorID, eventType, subjectType, subjectID, Date.now(), JSON.stringify(metadata));
}
