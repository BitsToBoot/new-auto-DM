import { prisma } from "@/lib/db/client";

export interface RetentionCleanupOptions {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface RetentionCleanupResult {
  deletedCount: number;
  batchesExecuted: number;
  cutoffDate: Date;
}

/**
 * Safely deletes old WebhookEvents in bounded batches to avoid table locking.
 * Default retention: 30 days.
 */
export async function cleanupExpiredWebhookEvents(
  options: RetentionCleanupOptions = {}
): Promise<RetentionCleanupResult> {
  const retentionDays = options.retentionDays ?? 30;
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 10;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  let totalDeleted = 0;
  let batches = 0;

  for (let i = 0; i < maxBatches; i++) {
    // Select batch IDs to delete to keep locking minimal
    const oldEvents = await prisma.webhookEvent.findMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
      select: { id: true },
      take: batchSize,
    });

    if (!oldEvents || oldEvents.length === 0) break;

    const ids = oldEvents.map((e: any) => e.id);
    const deleteResult = await prisma.webhookEvent.deleteMany({
      where: { id: { in: ids } },
    });

    totalDeleted += deleteResult.count;
    batches++;

    if (oldEvents.length < batchSize) break;
  }

  return {
    deletedCount: totalDeleted,
    batchesExecuted: batches,
    cutoffDate,
  };
}

/**
 * Deletes InboundComment intake records that finished processing. They are
 * kept at least 8 days (beyond Meta's 7-day private-reply window) so the
 * comment-level idempotency record outlives any webhook redelivery. RECEIVED
 * rows are never deleted here.
 */
export async function cleanupProcessedInboundComments(
  options: RetentionCleanupOptions = {}
): Promise<RetentionCleanupResult> {
  const retentionDays = Math.max(8, options.retentionDays ?? 30);
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 10;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  let totalDeleted = 0;
  let batches = 0;

  for (let i = 0; i < maxBatches; i++) {
    const oldRows = await prisma.inboundComment.findMany({
      where: { status: { in: ["PROCESSED", "IGNORED"] }, receivedAt: { lt: cutoffDate } },
      select: { id: true },
      take: batchSize,
    });
    if (oldRows.length === 0) break;

    const deleteResult = await prisma.inboundComment.deleteMany({
      where: { id: { in: oldRows.map((row) => row.id) } },
    });
    totalDeleted += deleteResult.count;
    batches++;
    if (oldRows.length < batchSize) break;
  }

  return { deletedCount: totalDeleted, batchesExecuted: batches, cutoffDate };
}
