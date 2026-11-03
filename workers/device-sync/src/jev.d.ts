export interface JevDecisionResult {
  model: string | null;
  answers: Record<string, { choice?: string; score?: number; confidence?: number }>;
}
export function callJevDecision(
  env: { OPENROUTER_API_KEY?: string },
  options: { state: string; questions: object },
): Promise<JevDecisionResult>;
