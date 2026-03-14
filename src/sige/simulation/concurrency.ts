export interface Semaphore {
  readonly acquire: () => Promise<void>
  readonly release: () => void
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  let active = 0
  const queue: Array<() => void> = []

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active++
        resolve()
      })
    })
  }

  function release(): void {
    active--
    const next = queue.shift()
    if (next !== undefined) {
      next()
    }
  }

  return { acquire, release }
}

export async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  maxConcurrent: number,
): Promise<readonly T[]> {
  const sem = createSemaphore(maxConcurrent)

  const wrapped = tasks.map((task) =>
    async (): Promise<T> => {
      await sem.acquire()
      try {
        return await task()
      } finally {
        sem.release()
      }
    },
  )

  const results = await Promise.allSettled(wrapped.map((fn) => fn()))

  const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
  if (firstRejection !== undefined) {
    throw firstRejection.reason
  }

  return results.map((r) => (r as PromiseFulfilledResult<T>).value)
}
