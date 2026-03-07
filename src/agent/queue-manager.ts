import { createLogger } from "../logger";
import { getDb } from "../store/db";
import { windowToHours } from "./utils/interval";

const log = createLogger("queue-manager");

/**
 * Task priority levels
 */
export enum TaskPriority {
  LOW = 1,
  NORMAL = 5,
  HIGH = 10,
  CRITICAL = 20,
}

/**
 * Queue task status
 */
export type QueueStatus =
  | "pending"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Queued task interface
 */
export interface QueuedTask {
  queueId: string;
  taskId: string;
  sessionId: string;
  domain: string;
  task: string;
  priority: number;
  status: QueueStatus;
  preferredAgent?: string;
  assignedAgent?: string;
  enqueuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
}

/**
 * Enqueue a task for processing
 */
export async function enqueueTask(
  taskId: string,
  sessionId: string,
  domain: string,
  task: string,
  options?: {
    priority?: TaskPriority;
    preferredAgent?: string;
    maxRetries?: number;
  },
): Promise<string> {
  const db = getDb();
  const queueId = `queue-${taskId}-${Date.now()}`;
  const priority = options?.priority || TaskPriority.NORMAL;

  try {
    await db`
      INSERT INTO task_queue (
        queue_id, task_id, session_id, domain, task,
        priority, preferred_agent, max_retries, status, enqueued_at
      )
      VALUES (
        ${queueId}, ${taskId}, ${sessionId}, ${domain}, ${task},
        ${priority}, ${options?.preferredAgent || null},
        ${options?.maxRetries ?? 3}, 'pending', NOW()
      )
    `;

    log.info("Enqueued task", {
      queueId,
      taskId,
      sessionId,
      domain,
      priority,
      preferredAgent: options?.preferredAgent,
    });

    return queueId;
  } catch (err) {
    log.error("Failed to enqueue task", {
      taskId,
      sessionId,
      error: String(err),
    });
    throw err;
  }
}

/**
 * Dequeue the next task for an agent
 */
export async function dequeueTask(
  agentId: string,
  domain?: string,
): Promise<QueuedTask | null> {
  const db = getDb();

  try {
    // Use a CTE with FOR UPDATE SKIP LOCKED to atomically claim a task
    const result = await db`
      WITH claimed_task AS (
        UPDATE task_queue
        SET
          assigned_agent = ${agentId},
          status = 'running',
          started_at = NOW()
        WHERE queue_id = (
          SELECT queue_id
          FROM task_queue
          WHERE status = 'pending'
            ${domain ? db`AND domain = ${domain}` : db``}
          ORDER BY (priority + EXTRACT(EPOCH FROM (NOW() - enqueued_at)) / 3600.0) DESC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      )
      SELECT * FROM claimed_task
    `;

    if (!result || result.length === 0) {
      return null;
    }

    const row = result[0];
    log.info("Dequeued task", {
      queueId: row.queue_id,
      taskId: row.task_id,
      agentId,
      domain: row.domain,
      priority: row.priority,
    });

    return {
      queueId: row.queue_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      domain: row.domain,
      task: row.task,
      priority: row.priority,
      status: "running" as QueueStatus,
      preferredAgent: row.preferred_agent,
      assignedAgent: row.assigned_agent,
      enqueuedAt: row.enqueued_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
      retryCount: row.retry_count ?? 0,
      maxRetries: row.max_retries ?? 3,
    };
  } catch (err) {
    log.error("Failed to dequeue task", {
      agentId,
      domain,
      error: String(err),
    });
    return null;
  }
}

/**
 * Mark a task as completed
 */
export async function completeTask(
  queueId: string,
  result?: string,
): Promise<void> {
  const db = getDb();

  try {
    await db`
      UPDATE task_queue
      SET
        status = 'completed',
        completed_at = NOW(),
        result = ${result || null}
      WHERE queue_id = ${queueId}
    `;

    log.debug("Completed task", { queueId });
  } catch (err) {
    log.warn("Failed to complete task", {
      queueId,
      error: String(err),
    });
  }
}

/**
 * Mark a task as failed
 */
export async function failTask(
  queueId: string,
  errorMessage: string,
): Promise<void> {
  const db = getDb();

  try {
    // Atomically increment retry_count and check if retries exhausted
    const rows = await db`
      UPDATE task_queue
      SET retry_count = retry_count + 1
      WHERE queue_id = ${queueId}
      RETURNING queue_id, task_id, session_id, domain, task, priority,
        preferred_agent, assigned_agent, retry_count, max_retries, enqueued_at
    `;

    if (rows.length === 0) return;

    const row = rows[0] as Record<string, unknown>;
    const retryCount = row.retry_count as number;
    const maxRetries = row.max_retries as number;

    if (retryCount >= maxRetries) {
      // Move to dead_tasks and remove from queue
      await db`
        INSERT INTO dead_tasks (
          queue_id, task_id, session_id, domain, task, priority,
          preferred_agent, assigned_agent, error_message, retry_count, enqueued_at
        ) VALUES (
          ${row.queue_id}, ${row.task_id}, ${row.session_id}, ${row.domain},
          ${row.task}, ${row.priority}, ${row.preferred_agent}, ${row.assigned_agent},
          ${errorMessage}, ${retryCount}, ${row.enqueued_at}
        )
        ON CONFLICT (queue_id) DO NOTHING
      `;

      await db`DELETE FROM task_queue WHERE queue_id = ${queueId}`;

      log.error("Task moved to dead letter queue", {
        queueId,
        retryCount,
        maxRetries,
        error: errorMessage,
      });
    } else {
      // Re-enqueue for retry
      await db`
        UPDATE task_queue
        SET
          status = 'pending',
          assigned_agent = NULL,
          started_at = NULL,
          completed_at = NULL,
          error_message = ${errorMessage}
        WHERE queue_id = ${queueId}
      `;

      log.warn("Task failed, re-enqueued for retry", {
        queueId,
        retryCount,
        maxRetries,
        error: errorMessage,
      });
    }
  } catch (err) {
    log.error("Failed to handle task failure", {
      queueId,
      error: String(err),
    });
  }
}

/**
 * Get queue status for a session
 */
export async function getSessionQueueStatus(sessionId: string): Promise<{
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
}> {
  const db = getDb();

  try {
    const result = await db`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM task_queue
      WHERE session_id = ${sessionId}
    `;

    if (!result || result.length === 0) {
      return {
        pendingTasks: 0,
        runningTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
      };
    }

    const row = result[0];
    return {
      pendingTasks: Number(row.pending),
      runningTasks: Number(row.running),
      completedTasks: Number(row.completed),
      failedTasks: Number(row.failed),
    };
  } catch (err) {
    log.warn("Failed to get queue status", {
      sessionId,
      error: String(err),
    });
    return {
      pendingTasks: 0,
      runningTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
    };
  }
}

/**
 * Get pending tasks count by domain
 */
export async function getQueueDepthByDomain(): Promise<
  Array<{ domain: string; count: number; avgPriority: number }>
> {
  const db = getDb();

  try {
    const result = await db`
      SELECT
        domain,
        COUNT(*) as count,
        AVG(priority) as avg_priority
      FROM task_queue
      WHERE status = 'pending'
      GROUP BY domain
      ORDER BY count DESC
    `;

    return (result || []).map((row: any) => ({
      domain: row.domain,
      count: Number(row.count),
      avgPriority: Number(row.avg_priority),
    }));
  } catch (err) {
    log.warn("Failed to get queue depth by domain", {
      error: String(err),
    });
    return [];
  }
}

/**
 * Cancel all pending tasks for a session
 */
export async function cancelSessionTasks(sessionId: string): Promise<number> {
  const db = getDb();

  try {
    const result = await db`
      UPDATE task_queue
      SET
        status = 'cancelled',
        completed_at = NOW()
      WHERE session_id = ${sessionId}
        AND status IN ('pending', 'running')
      RETURNING queue_id
    `;

    const cancelledCount = result?.length || 0;
    log.info("Cancelled session tasks", {
      sessionId,
      cancelledCount,
    });

    return cancelledCount;
  } catch (err) {
    log.error("Failed to cancel session tasks", {
      sessionId,
      error: String(err),
    });
    return 0;
  }
}

/**
 * Get queue statistics for monitoring
 */
export async function getQueueStats(window: string = "24h"): Promise<{
  totalEnqueued: number;
  totalCompleted: number;
  totalFailed: number;
  avgWaitTimeSec: number;
  avgProcessTimeSec: number;
}> {
  const db = getDb();
  const hours = windowToHours(window);

  try {
    const result = await db`
      SELECT
        COUNT(*) FILTER (WHERE enqueued_at >= NOW() - (${hours} * INTERVAL '1 hour')) as total_enqueued,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - (${hours} * INTERVAL '1 hour')) as total_completed,
        COUNT(*) FILTER (WHERE status = 'failed' AND completed_at >= NOW() - (${hours} * INTERVAL '1 hour')) as total_failed,
        AVG(EXTRACT(EPOCH FROM (started_at - enqueued_at))) FILTER (WHERE started_at IS NOT NULL) as avg_wait_time,
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE completed_at IS NOT NULL AND status = 'completed') as avg_process_time
      FROM task_queue
    `;

    if (!result || result.length === 0) {
      return {
        totalEnqueued: 0,
        totalCompleted: 0,
        totalFailed: 0,
        avgWaitTimeSec: 0,
        avgProcessTimeSec: 0,
      };
    }

    const row = result[0];
    return {
      totalEnqueued: Number(row.total_enqueued),
      totalCompleted: Number(row.total_completed),
      totalFailed: Number(row.total_failed),
      avgWaitTimeSec: Number(row.avg_wait_time) || 0,
      avgProcessTimeSec: Number(row.avg_process_time) || 0,
    };
  } catch (err) {
    log.warn("Failed to get queue stats", { error: String(err) });
    return {
      totalEnqueued: 0,
      totalCompleted: 0,
      totalFailed: 0,
      avgWaitTimeSec: 0,
      avgProcessTimeSec: 0,
    };
  }
}
