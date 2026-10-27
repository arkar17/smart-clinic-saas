/** Arch 17: interactive transactions with a 5 s timeout; waiting for a pooled connection may take longer under bursts. */
export const TX = { maxWait: 10_000, timeout: 5_000 };

/**
 * Concurrent writers of overlapping ranges / locked rows can deadlock (SQLSTATE 40P01); PostgreSQL aborts one
 * transaction. Re-running it sees the committed winner and fails cleanly with the business error.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !/deadlock detected|40P01/.test(e instanceof Error ? e.message : '')) throw e;
    }
  }
}
