/** Fetch a management API response without using a cached copy. */
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, cache: "no-store" });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result as T;
}
