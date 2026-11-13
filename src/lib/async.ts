/**
 * Run async tasks with a bounded concurrency. Tool calls are independent, so a
 * small pool keeps latency low without letting a misbehaving model fan out an
 * unbounded number of outbound search requests.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Truncate a string, appending an ellipsis when shortened. */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
