const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "~typesafe/jev-latest";
const MAX_STATE_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export class JEVRequestError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "JEVRequestError";
    this.status = status;
  }
}

/** Call the typed JEV decisions API with a server-owned question schema. */
export async function callJevDecision(env, {
  state,
  questions,
  fetcher = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof env?.OPENROUTER_API_KEY !== "string" || !env.OPENROUTER_API_KEY.trim()) {
    throw new JEVRequestError("JEV is not configured.", 503);
  }
  if (typeof state !== "string" || !state.trim()) throw new TypeError("JEV state must be a non-empty string.");
  if (new TextEncoder().encode(state).byteLength > MAX_STATE_BYTES) throw new RangeError("JEV state is too large.");
  if (!isQuestionSchema(questions)) throw new TypeError("JEV questions must be a fixed typed schema.");
  if (typeof fetcher !== "function") throw new TypeError("JEV fetcher must be a function.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({ model: env.JEV_MODEL || DEFAULT_MODEL, state, questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new JEVRequestError("JEV provider request failed.");
    const raw = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new JEVRequestError("JEV provider returned invalid JSON."); }
    if (!payload || typeof payload !== "object" || !validateAnswers(payload.answers, questions)) {
      throw new JEVRequestError("JEV returned invalid decision answers.");
    }
    return {
      model: typeof payload.model === "string" ? payload.model.slice(0, 120) : null,
      id: typeof payload.id === "string" ? payload.id.slice(0, 160) : null,
      answers: payload.answers,
      usage: normalizeUsage(payload.usage),
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new JEVRequestError("JEV provider request timed out.", 504);
    if (error instanceof JEVRequestError) throw error;
    throw new JEVRequestError("JEV provider request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

export function validateAnswers(answers, questions) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || !isQuestionSchema(questions)) return false;
  const expected = Object.keys(questions).sort();
  if (Object.keys(answers).sort().join("\0") !== expected.join("\0")) return false;
  return expected.every((key) => validateAnswer(answers[key], questions[key]));
}

function validateAnswer(answer, question) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer) || answer.type !== question.type) return false;
  if (question.type === "noul") {
    return Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 &&
      (answer.confidence === undefined || isProbability(answer.confidence));
  }
  const choices = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const value = question.type === "choice" ? answer.choice : answer.score;
  if (!Number.isFinite(value) && question.type === "score") return false;
  if (question.type === "choice" && !choices.includes(value)) return false;
  if (question.type === "score" && (value < 0 || value > choices.length - 1)) return false;
  if (!isProbability(answer.confidence)) return false;
  if (answer.probabilities !== undefined) {
    const probabilities = answer.probabilities;
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return false;
    if (Object.keys(probabilities).sort().join("\0") !== choices.sort().join("\0")) return false;
    const values = Object.values(probabilities);
    if (!values.every(isProbability) || Math.abs(values.reduce((sum, item) => sum + item, 0) - 1) > 0.02) return false;
  } else return false;
  if (question.type === "score") {
    const expectedLegend = Object.fromEntries(question.criteria.map((label, index) => [String(index), label]));
    if (!answer.legend || JSON.stringify(answer.legend) !== JSON.stringify(expectedLegend)) return false;
  }
  return true;
}

function isQuestionSchema(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return false;
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > 12) return false;
  return entries.every(([key, question]) => /^[a-z][a-z0-9_]{0,39}$/.test(key) && question &&
    typeof question === "object" && typeof question.instructions === "string" &&
    (question.type === "noul" ||
      (question.type === "choice" && question.criteria && typeof question.criteria === "object" && !Array.isArray(question.criteria) && Object.keys(question.criteria).length > 0) ||
      (question.type === "score" && Array.isArray(question.criteria) && question.criteria.length > 0)));
}

function isProbability(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const normalized = {};
  for (const key of ["input_tokens", "output_tokens"]) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) normalized[key] = usage[key];
  }
  if (Number.isFinite(usage.cost) && usage.cost >= 0) normalized.cost = usage.cost;
  return Object.keys(normalized).length ? normalized : null;
}

async function readBoundedResponse(response, maximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new JEVRequestError("JEV provider response was too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
