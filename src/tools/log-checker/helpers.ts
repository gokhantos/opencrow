// Shared types and utility functions for log-checker tools

export interface LogRow {
  readonly id: bigint;
  readonly process_name: string;
  readonly level: string;
  readonly context: string;
  readonly message: string;
  readonly data_json: string | null;
  readonly created_at: number;
}

export interface AggregateRow {
  readonly bucket: string;
  readonly count: bigint;
}

export interface TimelineRow {
  readonly time_bucket: string;
  readonly count: bigint;
  readonly error_count: bigint;
  readonly warn_count: bigint;
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + "...";
}
