import { useState, useCallback, useEffect } from "react";

/**
 * Drop-in replacement for useState that persists the value to localStorage.
 * Reads the initial value from localStorage, falling back to defaultValue if
 * the key is missing or the stored JSON is invalid.
 *
 * Cross-tab sync: subscribes to the window "storage" event so that changes
 * made in another tab are reflected in this tab's React state without
 * re-writing to localStorage (which would trigger an infinite loop).
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

  // Sync changes made in other browser tabs by listening to the storage event.
  // Only updates in-memory React state — does NOT re-write to localStorage.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || e.key !== key) return;
      if (e.newValue === null) {
        // Key was removed in another tab — revert to default.
        setValue(defaultValue);
        return;
      }
      try {
        setValue(JSON.parse(e.newValue) as T);
      } catch {
        // Malformed JSON from another tab — ignore, keep current value.
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [key, defaultValue]);

  return [value, setStoredValue];
}
