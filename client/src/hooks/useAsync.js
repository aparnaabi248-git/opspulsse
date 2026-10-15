import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async function and manages { data, loading, error }.
 *
 *   const { data, loading, error, reload } = useAsync(() => api.list(), []);
 *
 * `reload()` re-runs the function, `setData()` lets you patch the result
 * locally after a mutation without a second round trip.
 */
export function useAsync(fn, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const mounted = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (mounted.current) setData(result);
      return result;
    } catch (err) {
      if (mounted.current) setError(err);
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, setData, loading, error, reload: run };
}

/**
 * Debounces a fast-changing value (search boxes).
 */
export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Re-runs `fn` every `intervalMs`. Used to keep "time since last check"
 * and relative timestamps fresh. Pass 0 to disable.
 */
export function useInterval(fn, intervalMs) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!intervalMs) return undefined;
    const id = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/**
 * A ticking clock value so relative times update without a re-fetch.
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), intervalMs);
  return now;
}