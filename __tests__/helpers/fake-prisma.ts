/**
 * In-memory Prisma fake for integration-style tests of the delivery engine.
 *
 * Faithful where correctness depends on it:
 * - Unique constraints (including compound and nullable unique columns) throw
 *   `{ code: "P2002" }` on create AND update, like PostgreSQL.
 * - `updateMany` evaluates its where clause and applies its data in one
 *   synchronous step, so conditional updates are atomic exactly like a single
 *   SQL UPDATE, while separate calls interleave at `await` points like
 *   concurrent workers do.
 * - `$transaction(fn)` rolls every table back if fn throws.
 * - ORDER BY uses PostgreSQL null ordering (ASC NULLS LAST, DESC NULLS FIRST).
 *
 * Only the query features used by the application are implemented.
 */

type Row = Record<string, any>;

interface RelationDef {
  model: string;
  kind: "one" | "many";
  /** Field on this model ("one") or on the related model ("many"). */
  localKey: string;
  foreignKey: string;
}

interface ModelDef {
  uniques: string[][];
  defaults?: () => Row;
  relations?: Record<string, RelationDef>;
}

const MODELS: Record<string, ModelDef> = {
  workspace: { uniques: [["id"]], defaults: () => ({ plan: "FREE", subscriptionStatus: "NONE", dmsSentThisPeriod: 0 }) },
  instagramAccount: {
    uniques: [["id"], ["instagramId"]],
    defaults: () => ({
      status: "CONNECTED",
      webhookSubscribed: false,
      connectedAt: new Date(),
      tokenExpiresAt: null,
      disconnectedAt: null,
      disconnectReason: null,
      webhookUnsubscribedAt: null,
      webhookUnsubscribeError: null,
      name: null,
    }),
  },
  automation: {
    uniques: [["id"], ["reportShareSlug"]],
    defaults: () => ({
      triggerType: "COMMENT",
      triggerScope: "SPECIFIC_POST",
      postId: null,
      consumedPostId: null,
      consumedAt: null,
      keywords: [],
      publicReplyMessage: null,
      isActive: true,
      wholeWordMatch: true,
      reportShareSlug: null,
    }),
    relations: {
      keywordsList: { model: "automationKeyword", kind: "many", localKey: "id", foreignKey: "automationId" },
      variations: { model: "automationMessageVariation", kind: "many", localKey: "id", foreignKey: "automationId" },
      trackedLinks: { model: "trackedLink", kind: "many", localKey: "id", foreignKey: "automationId" },
      instagramAccount: { model: "instagramAccount", kind: "one", localKey: "instagramAccountId", foreignKey: "id" },
      workspace: { model: "workspace", kind: "one", localKey: "workspaceId", foreignKey: "id" },
    },
  },
  automationKeyword: { uniques: [["id"], ["automationId", "normalizedKeyword"]] },
  automationMessageVariation: { uniques: [["id"]], defaults: () => ({ isActive: true }) },
  trackedLink: {
    uniques: [["id"], ["slug"]],
    defaults: () => ({ active: true, label: null }),
    relations: {
      automation: { model: "automation", kind: "one", localKey: "automationId", foreignKey: "id" },
    },
  },
  contact: {
    uniques: [["id"], ["workspaceId", "instagramAccountId", "instagramUserId"]],
    defaults: () => ({ username: null, displayName: null }),
  },
  contactEvent: { uniques: [["id"]], defaults: () => ({ referenceId: null, metadata: null }) },
  inboundComment: {
    uniques: [["id"], ["instagramAccountId", "commentId"]],
    defaults: () => ({ status: "RECEIVED", outcome: null, attempts: 0, receivedAt: new Date(), processedAt: null, commenterUsername: null }),
  },
  deliveryJob: {
    uniques: [["id"], ["automationId", "triggerId"], ["dedupKey"], ["legacyDmLogId"]],
    defaults: () => ({
      triggerType: "COMMENT",
      status: "PENDING",
      contactId: null,
      recipientUsername: null,
      matchedKeyword: null,
      selectedVariationId: null,
      attemptCount: 0,
      scheduledAt: new Date(),
      processingStartedAt: null,
      sentAt: null,
      metaMessageId: null,
      lastError: null,
      errorCode: null,
      mediaId: null,
      commentText: null,
      commentedAt: null,
      deadlineAt: null,
      rateLimitDeferrals: 0,
      dedupKey: null,
      dedupOfDeliveryJobId: null,
      legacyDmLogId: null,
    }),
    relations: {
      instagramAccount: { model: "instagramAccount", kind: "one", localKey: "instagramAccountId", foreignKey: "id" },
      automation: { model: "automation", kind: "one", localKey: "automationId", foreignKey: "id" },
      attempts: { model: "deliveryAttempt", kind: "many", localKey: "id", foreignKey: "deliveryJobId" },
    },
  },
  deliveryAttempt: { uniques: [["id"], ["deliveryJobId", "attemptNumber"]] },
  linkClick: { uniques: [["id"]] },
  operationalEvent: { uniques: [["id"]], defaults: () => ({ resolvedAt: null, payload: null }) },
  webhookEvent: { uniques: [["id"]] },
};

let idCounter = 0;
function nextId(model: string) {
  idCounter += 1;
  return `${model}_${idCounter.toString().padStart(6, "0")}`;
}

export function uniqueError(model: string, fields: string[]) {
  return Object.assign(new Error(`Unique constraint failed on ${model}(${fields.join(", ")})`), {
    code: "P2002",
    meta: { modelName: model, target: fields },
  });
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) {
    return a != null && b != null && new Date(a as Date).getTime() === new Date(b as Date).getTime();
  }
  return (a ?? null) === (b ?? null);
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number | string);
  const bv = b instanceof Date ? b.getTime() : (b as number | string);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

const OPERATOR_KEYS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "equals", "contains"]);

function matchField(value: unknown, condition: unknown): boolean {
  if (!isPlainObject(condition) || !Object.keys(condition).every((k) => OPERATOR_KEYS.has(k))) {
    return valuesEqual(value, condition);
  }
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case "equals":
        if (!valuesEqual(value, operand)) return false;
        break;
      case "in":
        if (!(operand as unknown[]).some((o) => valuesEqual(value, o))) return false;
        break;
      case "notIn":
        if ((operand as unknown[]).some((o) => valuesEqual(value, o))) return false;
        break;
      case "not":
        if (matchField(value, operand)) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.includes(String(operand))) return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (value == null) return false;
        const c = compare(value, operand);
        if (op === "lt" && !(c < 0)) return false;
        if (op === "lte" && !(c <= 0)) return false;
        if (op === "gt" && !(c > 0)) return false;
        if (op === "gte" && !(c >= 0)) return false;
        break;
      }
    }
  }
  return true;
}

export class FakePrisma {
  tables: Record<string, Row[]> = {};
  /** Optional hook to inject failures: called before every operation. */
  beforeOperation?: (model: string, operation: string, args: unknown) => void;

  constructor() {
    for (const model of Object.keys(MODELS)) this.tables[model] = [];
    for (const model of Object.keys(MODELS)) {
      (this as any)[model] = this.delegate(model);
    }
  }

  reset() {
    for (const model of Object.keys(MODELS)) this.tables[model] = [];
    this.beforeOperation = undefined;
  }

  seed(model: string, data: Row) {
    return this.insert(model, data);
  }

  async $transaction<T>(arg: ((tx: FakePrisma) => Promise<T>) | Promise<unknown>[]): Promise<T | unknown[]> {
    if (Array.isArray(arg)) return Promise.all(arg);
    // Writes replace field values (never mutate nested objects), so a per-row
    // shallow snapshot is enough to roll back.
    const snapshot = Object.fromEntries(
      Object.entries(this.tables).map(([model, rows]) => [model, rows.map((row) => ({ ...row }))])
    );
    const liveRows = Object.fromEntries(
      Object.entries(this.tables).map(([model, rows]) => [model, [...rows]])
    );
    try {
      return await arg(this);
    } catch (error) {
      for (const [model, rows] of Object.entries(snapshot)) {
        // Restore original row objects (callers may hold references) and drop inserts.
        this.tables[model] = liveRows[model].map((row, index) => Object.assign(row, rows[index]));
      }
      throw error;
    }
  }

  async $executeRawUnsafe(): Promise<number> {
    return 0;
  }

  /** Raw SQL is not interpreted; tests that need rows mock this per call. */
  rawResults: unknown[][] = [];
  async $queryRaw(): Promise<unknown[]> {
    return this.rawResults.shift() ?? [];
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      if (key === "OR") {
        if (!(condition as Row[]).some((c) => this.matches(model, row, c))) return false;
        continue;
      }
      if (key === "AND") {
        const list = Array.isArray(condition) ? condition : [condition];
        if (!list.every((c: Row) => this.matches(model, row, c))) return false;
        continue;
      }
      if (key === "NOT") {
        if (this.matches(model, row, condition as Row)) return false;
        continue;
      }
      const relation = MODELS[model].relations?.[key];
      if (relation && isPlainObject(condition)) {
        const related = this.related(model, row, key);
        if (relation.kind === "one") {
          if (!related || !this.matches(relation.model, related as Row, condition)) return false;
          continue;
        }
      }
      // Compound unique selector, e.g. automationId_triggerId: { ... }
      if (!(key in row) && isPlainObject(condition) && key.includes("_")) {
        if (!this.matches(model, row, condition)) return false;
        continue;
      }
      if (!matchField(row[key], condition)) return false;
    }
    return true;
  }

  private related(model: string, row: Row, relationName: string): Row | Row[] | null {
    const relation = MODELS[model].relations![relationName];
    const table = this.tables[relation.model];
    if (relation.kind === "one") {
      return table.find((r) => valuesEqual(r[relation.foreignKey], row[relation.localKey])) ?? null;
    }
    return table.filter((r) => valuesEqual(r[relation.foreignKey], row[relation.localKey]));
  }

  private sort(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        for (const [field, dirSpec] of Object.entries(spec)) {
          const dir = typeof dirSpec === "string" ? dirSpec : dirSpec.sort;
          const nulls = typeof dirSpec === "string" ? (dir === "asc" ? "last" : "first") : dirSpec.nulls ?? (dir === "asc" ? "last" : "first");
          const av = a[field];
          const bv = b[field];
          if (av == null && bv == null) continue;
          if (av == null) return nulls === "first" ? -1 : 1;
          if (bv == null) return nulls === "first" ? 1 : -1;
          const c = compare(av, bv);
          if (c !== 0) return dir === "desc" ? -c : c;
        }
      }
      return 0;
    });
  }

  private project(model: string, row: Row, args: Row = {}): Row {
    const { select, include } = args;
    let out: Row;
    if (select) {
      out = {};
      for (const [key, spec] of Object.entries(select)) {
        if (!spec) continue;
        if (MODELS[model].relations?.[key]) {
          out[key] = this.loadRelation(model, row, key, spec === true ? {} : (spec as Row));
        } else {
          out[key] = row[key];
        }
      }
      return structuredClone(out);
    }
    out = structuredClone(row);
    for (const [key, spec] of Object.entries(include ?? {})) {
      if (!spec) continue;
      out[key] = this.loadRelation(model, row, key, spec === true ? {} : (spec as Row));
    }
    return out;
  }

  private loadRelation(model: string, row: Row, key: string, spec: Row) {
    const relation = MODELS[model].relations![key];
    const related = this.related(model, row, key);
    if (relation.kind === "one") {
      return related ? this.project(relation.model, related as Row, spec) : null;
    }
    let list = (related as Row[]).filter((r) => this.matches(relation.model, r, spec.where));
    list = this.sort(list, spec.orderBy);
    if (spec.take) list = list.slice(0, spec.take);
    return list.map((r) => this.project(relation.model, r, spec));
  }

  private assertUnique(model: string, candidate: Row, ignore?: Row) {
    for (const fields of MODELS[model].uniques) {
      if (fields.some((f) => candidate[f] == null)) continue;
      const clash = this.tables[model].some(
        (row) => row !== ignore && fields.every((f) => valuesEqual(row[f], candidate[f]))
      );
      if (clash) throw uniqueError(model, fields);
    }
  }

  private insert(model: string, data: Row): Row {
    const now = new Date();
    const row: Row = {
      ...(MODELS[model].defaults?.() ?? {}),
      createdAt: now,
      updatedAt: now,
      ...structuredClone(data),
    };
    if (!row.id) row.id = nextId(model);
    this.assertUnique(model, row);
    this.tables[model].push(row);
    return row;
  }

  private applyData(model: string, row: Row, data: Row) {
    const next: Row = { ...row };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && ("increment" in value || "decrement" in value)) {
        next[key] = (row[key] ?? 0) + (value.increment ?? 0) - (value.decrement ?? 0);
      } else if (isPlainObject(value) && "set" in value) {
        next[key] = value.set;
      } else {
        next[key] = value instanceof Date ? new Date(value) : value;
      }
    }
    next.updatedAt = new Date();
    this.assertUnique(model, next, row);
    Object.assign(row, next);
  }

  private delegate(model: string) {
    const hook = (op: string, args: unknown) => this.beforeOperation?.(model, op, args);
    return {
      findUnique: async (args: Row) => {
        hook("findUnique", args);
        const row = this.tables[model].find((r) => this.matches(model, r, args.where));
        return row ? this.project(model, row, args) : null;
      },
      findFirst: async (args: Row = {}) => {
        hook("findFirst", args);
        const rows = this.sort(this.tables[model].filter((r) => this.matches(model, r, args.where)), args.orderBy);
        return rows[0] ? this.project(model, rows[0], args) : null;
      },
      findMany: async (args: Row = {}) => {
        hook("findMany", args);
        let rows = this.sort(this.tables[model].filter((r) => this.matches(model, r, args.where)), args.orderBy);
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((r) => this.project(model, r, args));
      },
      count: async (args: Row = {}) => {
        hook("count", args);
        return this.tables[model].filter((r) => this.matches(model, r, args.where)).length;
      },
      create: async (args: Row) => {
        hook("create", args);
        return this.project(model, this.insert(model, args.data), args);
      },
      createMany: async (args: Row) => {
        hook("createMany", args);
        let count = 0;
        for (const data of args.data as Row[]) {
          try {
            this.insert(model, data);
            count++;
          } catch (error) {
            if (!(args.skipDuplicates && (error as { code?: string }).code === "P2002")) throw error;
          }
        }
        return { count };
      },
      update: async (args: Row) => {
        hook("update", args);
        const row = this.tables[model].find((r) => this.matches(model, r, args.where));
        if (!row) throw Object.assign(new Error(`${model} record not found`), { code: "P2025" });
        this.applyData(model, row, args.data);
        return this.project(model, row, args);
      },
      updateMany: async (args: Row) => {
        hook("updateMany", args);
        const rows = this.tables[model].filter((r) => this.matches(model, r, args.where));
        for (const row of rows) this.applyData(model, row, args.data);
        return { count: rows.length };
      },
      upsert: async (args: Row) => {
        hook("upsert", args);
        const row = this.tables[model].find((r) => this.matches(model, r, args.where));
        if (row) {
          this.applyData(model, row, args.update);
          return this.project(model, row, args);
        }
        return this.project(model, this.insert(model, args.create), args);
      },
      delete: async (args: Row) => {
        hook("delete", args);
        const index = this.tables[model].findIndex((r) => this.matches(model, r, args.where));
        if (index < 0) throw Object.assign(new Error(`${model} record not found`), { code: "P2025" });
        return this.tables[model].splice(index, 1)[0];
      },
      deleteMany: async (args: Row = {}) => {
        hook("deleteMany", args);
        const before = this.tables[model].length;
        this.tables[model] = this.tables[model].filter((r) => !this.matches(model, r, args.where));
        return { count: before - this.tables[model].length };
      },
      groupBy: async (args: Row) => {
        hook("groupBy", args);
        const rows = this.tables[model].filter((r) => this.matches(model, r, args.where));
        const groups = new Map<string, Row>();
        for (const row of rows) {
          const key = JSON.stringify((args.by as string[]).map((f) => row[f] ?? null));
          if (!groups.has(key)) {
            const group: Row = { _count: { _all: 0 } };
            for (const f of args.by as string[]) group[f] = row[f] ?? null;
            groups.set(key, group);
          }
          groups.get(key)!._count._all += 1;
        }
        return [...groups.values()];
      },
      aggregate: async (args: Row) => {
        hook("aggregate", args);
        const rows = this.tables[model].filter((r) => this.matches(model, r, args.where));
        const _sum: Row = {};
        for (const field of Object.keys(args._sum ?? {})) {
          _sum[field] = rows.reduce((total, r) => total + (r[field] ?? 0), 0);
        }
        return { _sum };
      },
    };
  }
}

export function createFakePrisma() {
  return new FakePrisma() as FakePrisma & Record<string, any>;
}
