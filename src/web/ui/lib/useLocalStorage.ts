import { useState, useCallback } from "react";

/**
 * Drop-in replacement for useState that persists the value to localStorage.
 * Reads the initial value from localStorage, falling back to defaultValue if
 * the key is missing or the stored JSON is invalid.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (val: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      return item !== null ? (JSON.parse(item) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setStoredValue = useCallback(
    (val: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next =
          typeof val === "function" ? (val as (p: T) => T)(prev) : val;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // quota exceeded or private browsing — degrade silently
        }
        return next;
      });
    },
    [key],
  );

  return [value, setStoredValue];
}
