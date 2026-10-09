/** Limit process startup only. Already launched browsers search independently. */
export function createLaunchLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(launch: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await launch();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
