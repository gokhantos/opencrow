import React, { createContext, useContext } from "react";
import type { ExecutionStepMap, StepInfo } from "./types";

const ExecutionStatusContext = createContext<ExecutionStepMap>(new Map());

export function ExecutionStatusProvider({
  stepStatuses,
  children,
}: {
  readonly stepStatuses: ExecutionStepMap;
  readonly children: React.ReactNode;
}) {
  return (
    <ExecutionStatusContext.Provider value={stepStatuses}>
      {children}
    </ExecutionStatusContext.Provider>
  );
}

export function useNodeStepInfo(nodeId: string): StepInfo | null {
  const ctx = useContext(ExecutionStatusContext);
  return ctx.get(nodeId) ?? null;
}
