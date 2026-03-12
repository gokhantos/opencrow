import React, { createContext, useContext } from "react";

type ValidationErrors = ReadonlyMap<string, readonly string[]>;

const ValidationContext = createContext<ValidationErrors>(new Map());

export function ValidationProvider({
  errors,
  children,
}: {
  readonly errors: ValidationErrors;
  readonly children: React.ReactNode;
}) {
  return (
    <ValidationContext.Provider value={errors}>
      {children}
    </ValidationContext.Provider>
  );
}

export function useValidationErrors(nodeId: string): readonly string[] {
  const ctx = useContext(ValidationContext);
  return ctx.get(nodeId) ?? [];
}
