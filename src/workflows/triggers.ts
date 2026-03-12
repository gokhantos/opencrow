import type { CronStore } from "../cron/store";
import type { Workflow, WorkflowNode } from "../store/workflows";
import { createLogger } from "../logger";

const log = createLogger("workflows:triggers");

const WORKFLOW_JOB_PREFIX = "workflow:";

function jobNameForWorkflow(workflowId: string): string {
  return `${WORKFLOW_JOB_PREFIX}${workflowId}`;
}

function findTriggerNode(workflow: Workflow): WorkflowNode | undefined {
  return workflow.nodes.find((n) => n.type === "trigger");
}

function getTriggerType(node: WorkflowNode): string | undefined {
  return node.data.triggerType as string | undefined;
}

function getCronExpression(node: WorkflowNode): string | undefined {
  return node.data.cronExpression as string | undefined;
}

async function findExistingCronJob(
  cronStore: CronStore,
  workflowId: string,
): Promise<string | null> {
  const jobs = await cronStore.listJobs();
  const jobName = jobNameForWorkflow(workflowId);
  const existing = jobs.find((j) => j.name === jobName);
  return existing?.id ?? null;
}

async function removeCronJobForWorkflow(
  cronStore: CronStore,
  workflowId: string,
): Promise<void> {
  const existingId = await findExistingCronJob(cronStore, workflowId);
  if (existingId) {
    await cronStore.removeJob(existingId);
    log.info("Removed cron job for workflow", { workflowId, jobId: existingId });
  }
}

async function upsertCronJobForWorkflow(
  cronStore: CronStore,
  workflow: Workflow,
  cronExpression: string,
): Promise<void> {
  const jobName = jobNameForWorkflow(workflow.id);
  const existingId = await findExistingCronJob(cronStore, workflow.id);

  const schedule = {
    kind: "cron" as const,
    expr: cronExpression,
  };

  const payload = {
    kind: "workflowRun" as const,
    workflowId: workflow.id,
  };

  if (existingId) {
    await cronStore.updateJob(existingId, { schedule, payload, enabled: true });
    log.info("Updated cron job for workflow", {
      workflowId: workflow.id,
      jobId: existingId,
      expr: cronExpression,
    });
  } else {
    const job = await cronStore.addJob({
      name: jobName,
      schedule,
      payload,
      enabled: true,
    });
    log.info("Created cron job for workflow", {
      workflowId: workflow.id,
      jobId: job.id,
      expr: cronExpression,
    });
  }
}

export async function syncWorkflowTriggers(
  workflow: Workflow,
  cronStore: CronStore,
): Promise<void> {
  const triggerNode = findTriggerNode(workflow);

  if (!triggerNode) {
    await removeCronJobForWorkflow(cronStore, workflow.id);
    return;
  }

  const triggerType = getTriggerType(triggerNode);

  if (!workflow.enabled || triggerType !== "cron") {
    await removeCronJobForWorkflow(cronStore, workflow.id);
    return;
  }

  const cronExpression = getCronExpression(triggerNode);
  if (!cronExpression) {
    log.warn("Cron workflow has no expression, removing job", {
      workflowId: workflow.id,
    });
    await removeCronJobForWorkflow(cronStore, workflow.id);
    return;
  }

  try {
    await upsertCronJobForWorkflow(cronStore, workflow, cronExpression);
  } catch (err) {
    log.error("Failed to sync cron trigger for workflow", {
      workflowId: workflow.id,
      err,
    });
  }
}
