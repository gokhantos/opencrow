interface LoadingStateProps {
  readonly message?: string;
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div role="status" aria-label={message ?? "Loading"} className="flex flex-col items-center justify-center py-24 px-6 gap-5">
      <span className="w-8 h-8 border-2 border-border-2 border-t-accent rounded-full animate-spin" aria-hidden="true" />
      {message && <span className="text-base text-muted">{message}</span>}
    </div>
  );
}
