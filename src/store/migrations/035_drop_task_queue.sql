-- Drop task_queue and dead_tasks tables (queue manager removed)

DROP TABLE IF EXISTS dead_tasks;
DROP TABLE IF EXISTS task_queue;

DROP INDEX IF EXISTS idx_task_queue_status;
DROP INDEX IF EXISTS idx_task_queue_session;
DROP INDEX IF EXISTS idx_task_queue_agent;
DROP INDEX IF EXISTS idx_dead_tasks_created;
