import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import { FabricClient } from "./client";
import {
  validateSparkSqlLiteral,
  type CanonicalLakehouseTable,
  type CanonicalLakehouseTableColumn,
  type LoadedLakehouseTable,
  type LoadedLakehouseTablesDefinition,
} from "./lakehouse-tables-definition";

const LIVY_API_VERSION = "2023-12-01";
const RESULT_MARKER = "FABRIC_DEPLOY_TABLE_RESULT:";
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_RECORD_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export const FABRIC_TABLE_SOURCE_HASH_PROPERTY =
  "fabric.deploy.sourceHash";
export const FABRIC_TABLE_OPERATION_HASH_PROPERTY =
  "fabric.deploy.operationHash";
export const FABRIC_TABLE_OWNER_SCHEME_PROPERTY =
  "fabric.deploy.ownerScheme";
export const FABRIC_TABLE_OWNER_ID_PROPERTY =
  "fabric.deploy.ownerId";
export const FABRIC_TABLE_DESIRED_HASH_PROPERTY =
  "fabric.deploy.desiredHash";
export const FABRIC_TABLE_OWNER_SCHEME_V1 = "v1";

export const PHASE3_DELTA_PROTOCOL_POLICY = {
  minReaderVersion: 1,
  minWriterVersion: 2,
  allowedTableFeatures: [] as readonly string[],
} as const;

const RESERVED_OWNERSHIP_PROPERTIES = [
  FABRIC_TABLE_OWNER_SCHEME_PROPERTY,
  FABRIC_TABLE_OWNER_ID_PROPERTY,
  FABRIC_TABLE_SOURCE_HASH_PROPERTY,
  FABRIC_TABLE_OPERATION_HASH_PROPERTY,
  FABRIC_TABLE_DESIRED_HASH_PROPERTY,
] as const;

const LEGACY_OWNERSHIP_PROPERTIES = [
  FABRIC_TABLE_SOURCE_HASH_PROPERTY,
  FABRIC_TABLE_OPERATION_HASH_PROPERTY,
] as const;

const SESSION_FAILURE_STATES = new Set([
  "dead",
  "error",
  "killed",
  "shutting_down",
  "success",
]);
const STATEMENT_FAILURE_STATES = new Set([
  "cancelled",
  "cancelling",
  "error",
  "failed",
]);

export interface LakehouseTablesExecutionContext {
  sourceHash: string;
  attemptId: string;
  deploymentId: string;
  bundleLogicalId: string;
  targetLakehouseLogicalId: string;
}

export interface LakehouseLivySessionConfiguration {
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  conf?: Record<string, string>;
}

export interface LakehouseTablesAdapterOptions {
  sessionPollIntervalMs?: number;
  statementPollIntervalMs?: number;
  sessionTimeoutMs?: number;
  statementTimeoutMs?: number;
  sessionConfiguration?: LakehouseLivySessionConfiguration;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface LakehouseTableOwnershipEvidence {
  ownerScheme: typeof FABRIC_TABLE_OWNER_SCHEME_V1;
  ownerId: string;
  desiredHash: string;
}

export type LakehouseTableOwnershipState =
  | "owned"
  | "unowned"
  | "conflicting";

export interface LakehouseTableObservation {
  schemaExists: boolean;
  exists: boolean;
  provider?: string;
  tableType?: string;
  managed?: boolean;
  columns?: CanonicalLakehouseTableColumn[];
  partitionColumns?: string[];
  comment?: string;
  properties?: Record<string, string>;
  minReaderVersion?: number;
  minWriterVersion?: number;
  tableFeatures?: string[];
}

export interface LakehouseTableVerification {
  logicalId: string;
  identifier: string;
  desiredHash: string;
  observedHash: string;
  observation: LakehouseTableObservation;
  expectedOwnership: LakehouseTableOwnershipEvidence;
  ownershipState: LakehouseTableOwnershipState;
  structureMatches: boolean;
  ownershipMatches: boolean;
  protocolCompatible: boolean;
  matches: boolean;
  differences: string[];
}

export interface LakehouseTablesVerificationResult {
  matches: boolean;
  observedStateHash: string;
  tables: LakehouseTableVerification[];
}

export type LakehouseTablePlanAction =
  | "create"
  | "adopt"
  | "no-op"
  | "blocked";

export interface LakehouseTablePlanEntry
  extends LakehouseTableVerification {
  action: LakehouseTablePlanAction;
  reason: string;
  adoptionOperation?: LakehouseTableAdoptionOperation;
}

export interface LakehouseTablesPlanResult {
  action: LakehouseTablePlanAction;
  reason: string;
  physicalId: string;
  observedStateHash: string;
  desiredHash: string;
  tables: LakehouseTablePlanEntry[];
}

export interface LakehouseTableCreateOperation {
  kind: "create-table";
  operationId: string;
  operationHash: string;
  order: number;
  logicalId: string;
  desiredHash: string;
  identifier: string;
  ownership: LakehouseTableOwnershipEvidence;
  table: CanonicalLakehouseTable;
  ddl: string;
}

export interface LakehouseTableAdoptionOperation {
  kind: "adopt-table-ownership";
  operationId: string;
  operationHash: string;
  logicalId: string;
  desiredHash: string;
  identifier: string;
  ownership: LakehouseTableOwnershipEvidence;
}

export type LakehouseTableOperation =
  | LakehouseTableCreateOperation
  | LakehouseTableAdoptionOperation;

export interface LakehouseSessionSubmittingContext {
  workspaceId: string;
  lakehouseId: string;
  sessionName: string;
  sessionsPath: string;
  attemptId: string;
  requestHash: string;
  submittedAt: string;
}

export interface LakehouseSessionAcceptedContext
  extends LakehouseSessionSubmittingContext {
  sessionId: string;
}

export type LakehouseStatementPurpose = "inspect" | "create";

export interface LakehouseStatementSubmittingContext {
  workspaceId: string;
  lakehouseId: string;
  sessionId: string;
  sessionName: string;
  statementAttemptName: string;
  purpose: LakehouseStatementPurpose;
  logicalId: string;
  operation?: LakehouseTableCreateOperation;
  codeHash: string;
}

export interface LakehouseStatementAcceptedContext
  extends LakehouseStatementSubmittingContext {
  statementId: number;
}

export interface LakehouseTableExecutionHooks {
  onSessionSubmitting?: (
    context: LakehouseSessionSubmittingContext,
  ) => void | Promise<void>;
  onSessionAccepted?: (
    context: LakehouseSessionAcceptedContext,
  ) => void | Promise<void>;
  onSessionCreated?: (
    context: LakehouseSessionAcceptedContext,
  ) => void | Promise<void>;
  onSessionCleanupSubmitting?: (
    context: LakehouseSessionAcceptedContext,
  ) => void | Promise<void>;
  onSessionCleanupComplete?: (
    context: LakehouseSessionAcceptedContext,
  ) => void | Promise<void>;
  onStatementSubmitting?: (
    context: LakehouseStatementSubmittingContext,
  ) => void | Promise<void>;
  onStatementAccepted?: (
    context: LakehouseStatementAcceptedContext,
  ) => void | Promise<void>;
  onOperationSubmitting?: (
    context: LakehouseStatementSubmittingContext & {
      operation: LakehouseTableCreateOperation;
    },
  ) => void | Promise<void>;
  onOperationAccepted?: (
    context: LakehouseStatementAcceptedContext & {
      operation: LakehouseTableCreateOperation;
    },
  ) => void | Promise<void>;
  onOperationVerified?: (
    context: LakehouseStatementAcceptedContext & {
      operation: LakehouseTableCreateOperation;
      verification: LakehouseTableVerification;
    },
  ) => void | Promise<void>;
}

export interface LakehouseTableApplyOperationResult {
  operationId: string;
  operationHash: string;
  logicalId: string;
  identifier: string;
  statementId: number;
  verification: LakehouseTableVerification;
}

export interface LakehouseTablesApplyResult {
  physicalId: string;
  desiredHash: string;
  observedStateHash: string;
  operations: LakehouseTableApplyOperationResult[];
  tables: LakehouseTableVerification[];
}

export interface DiscoveredLakehouseLivySession {
  id: string;
  name: string;
  state?: string;
  attemptId?: string;
  requestHash?: string;
  submittedAt?: string;
}

export type LakehouseSessionDiscoveryResult =
  | { outcome: "none"; sessionName: string }
  | {
      outcome: "single";
      sessionName: string;
      session: DiscoveredLakehouseLivySession;
    }
  | {
      outcome: "ambiguous";
      sessionName: string;
      sessions: DiscoveredLakehouseLivySession[];
    };

export interface LakehouseSessionAttemptDiscoveryRequest {
  sessionName: string;
  attemptId: string;
  requestHash: string;
  submittedAfter: string;
  submittedBefore: string;
}

export type LakehouseStatementDiscoveryResult =
  | { outcome: "none" }
  | { outcome: "single"; statementId: number; state: string }
  | {
      outcome: "ambiguous";
      statements: { statementId: number; state: string }[];
    };

export interface AmbiguousStatementRecoveryRequest {
  sessionName: string;
  statementId?: number;
  statementAttemptName?: string;
  codeHash?: string;
  operation?: LakehouseTableCreateOperation;
}

export type AmbiguousStatementRecoveryResult =
  | {
      outcome: "fail-closed";
      reason: string;
      session?: DiscoveredLakehouseLivySession;
    }
  | {
      outcome: "monitor";
      session: DiscoveredLakehouseLivySession;
      statementId: number;
      state: string;
    }
  | {
      outcome: "failed";
      session: DiscoveredLakehouseLivySession;
      statementId: number;
      reason: string;
    }
  | {
      outcome: "completed";
      session: DiscoveredLakehouseLivySession;
      statementId: number;
      verification?: LakehouseTableVerification;
    };

interface LivySession {
  id?: unknown;
  livyId?: unknown;
  name?: unknown;
  livyName?: unknown;
  state?: unknown;
  livyState?: unknown;
  tags?: unknown;
  submittedDateTime?: unknown;
  log?: unknown;
}

interface LivySessionList {
  items?: unknown;
  totalCountOfMatchedItems?: unknown;
  pageSize?: unknown;
}

interface LivyStatementOutput {
  status?: unknown;
  data?: unknown;
  ename?: unknown;
  evalue?: unknown;
  traceback?: unknown;
}

interface LivyStatement {
  id?: unknown;
  state?: unknown;
  output?: LivyStatementOutput | null;
  code?: unknown;
}

interface StatementExecutionResult {
  statementId: number;
  observation: LakehouseTableObservation;
}

interface ActiveSession {
  id: string;
  name: string;
  basePath: string;
  requestHash: string;
  submittedAt: string;
}

interface StatementDispatch {
  purpose: LakehouseStatementPurpose;
  logicalId: string;
  operation?: LakehouseTableCreateOperation;
}

export class LakehouseTableAdoptionRequiredError extends Error {
  constructor(readonly operation: LakehouseTableAdoptionOperation) {
    super(
      `Lakehouse table '${operation.identifier}' requires a separately approved ownership-adoption operation. Phase 3 does not execute ALTER TABLE.`,
    );
    this.name = "LakehouseTableAdoptionRequiredError";
  }
}

export class LakehouseTablesAdapter {
  private readonly options: Required<
    Pick<
      LakehouseTablesAdapterOptions,
      | "sessionPollIntervalMs"
      | "statementPollIntervalMs"
      | "sessionTimeoutMs"
      | "statementTimeoutMs"
      | "sleep"
      | "now"
    >
  > &
    LakehouseTablesAdapterOptions;

  constructor(
    private readonly client: FabricClient,
    options: LakehouseTablesAdapterOptions = {},
  ) {
    this.options = {
      ...options,
      sessionPollIntervalMs: options.sessionPollIntervalMs ?? 5_000,
      statementPollIntervalMs: options.statementPollIntervalMs ?? 2_000,
      sessionTimeoutMs: options.sessionTimeoutMs ?? 20 * 60 * 1000,
      statementTimeoutMs: options.statementTimeoutMs ?? 20 * 60 * 1000,
      sleep:
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
      now: options.now ?? Date.now,
    };
    validatePositiveOption(
      "sessionPollIntervalMs",
      this.options.sessionPollIntervalMs,
    );
    validatePositiveOption(
      "statementPollIntervalMs",
      this.options.statementPollIntervalMs,
    );
    validatePositiveOption("sessionTimeoutMs", this.options.sessionTimeoutMs);
    validatePositiveOption(
      "statementTimeoutMs",
      this.options.statementTimeoutMs,
    );
  }

  async plan(
    workspaceId: string,
    lakehouseId: string,
    definition: LoadedLakehouseTablesDefinition,
    execution: LakehouseTablesExecutionContext,
  ): Promise<LakehouseTablesPlanResult> {
    validateExecutionContext(execution);
    const verification = await this.verify(
      workspaceId,
      lakehouseId,
      definition,
      execution,
    );
    const loadedByLogicalId = new Map(
      definition.tables.map((table) => [table.logicalId, table]),
    );
    const tables: LakehouseTablePlanEntry[] =
      verification.tables.map((table) => {
        const loaded = loadedByLogicalId.get(table.logicalId)!;
        if (!table.observation.schemaExists) {
          return {
            ...table,
            action: "blocked",
            reason: `Schema '${loaded.table.schema}' does not exist; Phase 3 does not create schemas.`,
          };
        }
        if (!table.observation.exists) {
          return {
            ...table,
            action: "create",
            reason: `Table '${table.identifier}' does not exist.`,
          };
        }
        if (!table.structureMatches) {
          return {
            ...table,
            action: "blocked",
            reason: `Table '${table.identifier}' exists but differs: ${table.differences.join(
              "; ",
            )}`,
          };
        }
        if (table.ownershipState === "owned") {
          return {
            ...table,
            action: "no-op",
            reason: `Table '${table.identifier}' matches the desired owned managed Delta definition.`,
          };
        }
        if (
          table.ownershipState === "unowned" &&
          definition.adoptExisting
        ) {
          const adoptionOperation =
            buildLakehouseTableAdoptionOperation(loaded, execution);
          return {
            ...table,
            action: "adopt",
            reason: `Table '${table.identifier}' matches structurally but requires separately approved ownership stamping.`,
            adoptionOperation,
          };
        }
        return {
          ...table,
          action: "blocked",
          reason:
            table.ownershipState === "conflicting"
              ? `Table '${table.identifier}' contains conflicting Fabric deployment ownership evidence.`
              : `Table '${table.identifier}' is not owned by this deployment and adoptExisting is false.`,
        };
      });

    const blocked = tables.filter((table) => table.action === "blocked");
    const adoptions = tables.filter((table) => table.action === "adopt");
    const creates = tables.filter((table) => table.action === "create");
    const action: LakehouseTablePlanAction =
      blocked.length > 0
        ? "blocked"
        : adoptions.length > 0
          ? "adopt"
          : creates.length > 0
            ? "create"
            : "no-op";
    const reason =
      action === "blocked"
        ? `${blocked.length} Lakehouse table definition(s) are blocked.`
        : action === "adopt"
          ? `${adoptions.length} Lakehouse table(s) require separately approved ownership adoption.`
          : action === "create"
            ? `${creates.length} Lakehouse table(s) require creation.`
            : "All Lakehouse tables match the desired owned managed Delta definitions.";

    return {
      action,
      reason,
      physicalId: lakehouseId,
      observedStateHash: verification.observedStateHash,
      desiredHash: definition.desiredHash,
      tables,
    };
  }

  async apply(
    workspaceId: string,
    lakehouseId: string,
    definition: LoadedLakehouseTablesDefinition,
    execution: LakehouseTablesExecutionContext,
    hooks: LakehouseTableExecutionHooks = {},
  ): Promise<LakehouseTablesApplyResult> {
    validateExecutionContext(execution);
    const createOperations = buildLakehouseTableCreateOperations(
      definition,
      execution,
    );
    const createByLogicalId = new Map(
      createOperations.map((operation) => [
        operation.logicalId,
        operation,
      ]),
    );

    return this.withSession(
      workspaceId,
      lakehouseId,
      definition.desiredHash,
      execution,
      hooks,
      async (session) => {
        const preflight: LakehouseTableVerification[] = [];
        for (const loaded of definition.tables) {
          const operation = createByLogicalId.get(loaded.logicalId)!;
          const observation = await this.inspectTable(
            workspaceId,
            lakehouseId,
            session,
            loaded,
            execution,
            hooks,
          );
          preflight.push(
            verifyObservedTable(
              loaded.logicalId,
              loaded.desiredHash,
              loaded.table,
              observation,
              operation.ownership,
            ),
          );
        }

        for (const verification of preflight) {
          const loaded = definition.tables.find(
            (table) => table.logicalId === verification.logicalId,
          )!;
          if (!verification.observation.schemaExists) {
            throw new Error(
              `Lakehouse schema '${loaded.table.schema}' does not exist. Phase 3 fails closed and does not create schemas.`,
            );
          }
          if (!verification.observation.exists) {
            continue;
          }
          if (!verification.structureMatches) {
            throw new Error(
              `Lakehouse table '${verification.identifier}' preflight failed: ${verification.differences.join(
                "; ",
              )}`,
            );
          }
          if (verification.ownershipState === "owned") {
            continue;
          }
          if (
            verification.ownershipState === "unowned" &&
            definition.adoptExisting
          ) {
            throw new LakehouseTableAdoptionRequiredError(
              buildLakehouseTableAdoptionOperation(loaded, execution),
            );
          }
          throw new Error(
            verification.ownershipState === "conflicting"
              ? `Lakehouse table '${verification.identifier}' has conflicting Fabric deployment ownership evidence.`
              : `Lakehouse table '${verification.identifier}' is unowned and adoptExisting is false.`,
          );
        }

        const operationResults: LakehouseTableApplyOperationResult[] = [];
        const finalByLogicalId = new Map(
          preflight
            .filter((table) => table.matches)
            .map((table) => [table.logicalId, table]),
        );
        for (const operation of createOperations) {
          const before = preflight.find(
            (table) => table.logicalId === operation.logicalId,
          )!;
          if (before.observation.exists) {
            continue;
          }
          const dispatch: StatementDispatch = {
            purpose: "create",
            logicalId: operation.logicalId,
            operation,
          };
          const executionResult = await this.submitAndWaitForStatement(
            workspaceId,
            lakehouseId,
            session,
            generateCreateAndObservePySpark(operation),
            execution,
            dispatch,
            hooks,
          );
          const verification = verifyObservedTable(
            operation.logicalId,
            operation.desiredHash,
            operation.table,
            executionResult.observation,
            operation.ownership,
          );
          if (!verification.matches) {
            throw new Error(
              `Lakehouse table '${operation.identifier}' verification failed: ${verification.differences.join(
                "; ",
              )}`,
            );
          }
          const acceptedContext =
            makeAcceptedStatementContext(
              workspaceId,
              lakehouseId,
              session,
              execution,
              dispatch,
              executionResult.statementId,
              sha256(generateCreateAndObservePySpark(operation)),
            );
          await hooks.onOperationVerified?.({
            ...acceptedContext,
            operation,
            verification,
          });
          finalByLogicalId.set(operation.logicalId, verification);
          operationResults.push({
            operationId: operation.operationId,
            operationHash: operation.operationHash,
            logicalId: operation.logicalId,
            identifier: operation.identifier,
            statementId: executionResult.statementId,
            verification,
          });
        }
        const tables = definition.tables.map((table) => {
          const verification = finalByLogicalId.get(table.logicalId);
          if (!verification) {
            throw new Error(
              `Lakehouse table '${table.logicalId}' has no verified final state.`,
            );
          }
          return verification;
        });
        return {
          physicalId: lakehouseId,
          desiredHash: definition.desiredHash,
          observedStateHash: hashVerificationState(tables),
          operations: operationResults,
          tables,
        };
      },
    );
  }

  async verify(
    workspaceId: string,
    lakehouseId: string,
    definition: LoadedLakehouseTablesDefinition,
    execution: LakehouseTablesExecutionContext,
    hooks: LakehouseTableExecutionHooks = {},
  ): Promise<LakehouseTablesVerificationResult> {
    validateExecutionContext(execution);
    const operations = buildLakehouseTableCreateOperations(
      definition,
      execution,
    );
    const operationByLogicalId = new Map(
      operations.map((operation) => [operation.logicalId, operation]),
    );
    return this.withSession(
      workspaceId,
      lakehouseId,
      definition.desiredHash,
      execution,
      hooks,
      async (session) => {
        const tables: LakehouseTableVerification[] = [];
        for (const loaded of definition.tables) {
          const observation = await this.inspectTable(
            workspaceId,
            lakehouseId,
            session,
            loaded,
            execution,
            hooks,
          );
          const operation = operationByLogicalId.get(loaded.logicalId)!;
          tables.push(
            verifyObservedTable(
              loaded.logicalId,
              loaded.desiredHash,
              loaded.table,
              observation,
              operation.ownership,
            ),
          );
        }
        return {
          matches: tables.every((table) => table.matches),
          observedStateHash: hashVerificationState(tables),
          tables,
        };
      },
    );
  }

  async listSessions(
    workspaceId: string,
    lakehouseId: string,
  ): Promise<DiscoveredLakehouseLivySession[]> {
    const basePath = lakehouseLivySessionsPath(workspaceId, lakehouseId);
    const values: unknown[] = [];
    const top = 100;
    let skip = 0;
    while (true) {
      const response = await this.client.request<LivySessionList>(
        "GET",
        `${basePath}?$top=${top}&$skip=${skip}`,
      );
      const body = response.body;
      if (!body || !Array.isArray(body.items)) {
        throw new Error(
          "Fabric Livy session list response is missing the items array.",
        );
      }
      if (
        typeof body.totalCountOfMatchedItems !== "number" ||
        !Number.isInteger(body.totalCountOfMatchedItems) ||
        body.totalCountOfMatchedItems < 0 ||
        typeof body.pageSize !== "number" ||
        !Number.isInteger(body.pageSize) ||
        body.pageSize < 0
      ) {
        throw new Error(
          "Fabric Livy session list response has invalid count metadata.",
        );
      }
      values.push(...body.items);
      skip += body.items.length;
      if (skip >= body.totalCountOfMatchedItems) {
        break;
      }
      if (body.items.length === 0 || body.pageSize === 0) {
        throw new Error(
          "Fabric Livy session pagination made no progress.",
        );
      }
    }
    return values.map((value, index) => {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        throw new Error(`Fabric Livy session list entry ${index} is invalid.`);
      }
      const session = value as LivySession;
      const id = readSessionId(
        session.id ?? session.livyId,
        `Livy session list entry ${index}`,
      );
      const nameValue = session.name ?? session.livyName;
      if (typeof nameValue !== "string" || nameValue.length === 0) {
        throw new Error(
          `Livy session list entry ${index} is missing its name.`,
        );
      }
      return {
        id,
        name: nameValue,
        ...(typeof session.livyState === "string"
          ? { state: session.livyState.toLowerCase() }
          : {}),
        ...readSessionRecoveryMetadata(session),
      };
    });
  }

  async discoverSessionsByExactName(
    workspaceId: string,
    lakehouseId: string,
    sessionName: string,
  ): Promise<LakehouseSessionDiscoveryResult> {
    const sessions = (await this.listSessions(workspaceId, lakehouseId))
      .filter((session) => session.name === sessionName)
      .sort((left, right) =>
        compareCanonicalStrings(left.id, right.id),
      );
    if (sessions.length === 0) {
      return { outcome: "none", sessionName };
    }
    if (sessions.length === 1) {
      return {
        outcome: "single",
        sessionName,
        session: sessions[0]!,
      };
    }
    return { outcome: "ambiguous", sessionName, sessions };
  }

  async discoverSessionAttempt(
    workspaceId: string,
    lakehouseId: string,
    request: LakehouseSessionAttemptDiscoveryRequest,
  ): Promise<LakehouseSessionDiscoveryResult> {
      const after = Date.parse(request.submittedAfter);
      const before = Date.parse(request.submittedBefore);
      if (
        Number.isNaN(after) ||
        Number.isNaN(before) ||
        after > before
      ) {
        throw new Error("Livy session recovery time window is invalid.");
      }
      const candidates = (await this.listSessions(workspaceId, lakehouseId))
        .filter((session) => {
          const submitted = session.submittedAt
            ? Date.parse(session.submittedAt)
            : Number.NaN;
          return (
            session.name === request.sessionName &&
            session.attemptId === request.attemptId &&
            session.requestHash === request.requestHash &&
            !Number.isNaN(submitted) &&
            submitted >= after &&
            submitted <= before
          );
        })
        .sort((left, right) =>
          compareCanonicalStrings(left.id, right.id),
        );
      const confirmed: DiscoveredLakehouseLivySession[] = [];
      for (const candidate of candidates) {
        const detail = await this.client.request<LivySession>(
          "GET",
          `${lakehouseLivySessionsPath(
            workspaceId,
            lakehouseId,
          )}/${encodeURIComponent(candidate.id)}`,
        );
        if (!detail.body) {
          continue;
        }
        const metadata = readSessionRecoveryMetadata(detail.body);
        const detailName = detail.body.name ?? detail.body.livyName;
        if (
          detailName === request.sessionName &&
          metadata.attemptId === request.attemptId &&
          metadata.requestHash === request.requestHash
        ) {
          confirmed.push({
            ...candidate,
            state: readState(detail.body.state, "Livy session"),
          });
        }
      }
      if (confirmed.length === 0) {
        return { outcome: "none", sessionName: request.sessionName };
      }
      if (confirmed.length === 1) {
        return {
          outcome: "single",
          sessionName: request.sessionName,
          session: confirmed[0]!,
        };
      }
      return {
        outcome: "ambiguous",
        sessionName: request.sessionName,
        sessions: confirmed,
      };
  }

  async discoverStatementByMarker(
    workspaceId: string,
    lakehouseId: string,
    sessionId: string,
    statementAttemptName: string,
    codeHash: string,
  ): Promise<LakehouseStatementDiscoveryResult> {
      const path = `${lakehouseLivySessionsPath(
        workspaceId,
        lakehouseId,
      )}/${encodeURIComponent(sessionId)}/statements`;
      const response = await this.client.request<{
        statements?: unknown;
        items?: unknown;
      }>("GET", path);
      const values = Array.isArray(response.body?.statements)
        ? response.body.statements
        : Array.isArray(response.body?.items)
          ? response.body.items
          : undefined;
      if (!values) {
        throw new Error(
          "Fabric Livy statement list response is missing its statements array.",
        );
      }
      const marker = `_fabric_deploy_statement_attempt_name = ${JSON.stringify(
        statementAttemptName,
      )}`;
      const hashMarker = `_fabric_deploy_statement_code_hash = ${JSON.stringify(
        codeHash,
      )}`;
      const matches = values.flatMap((value) => {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          return [];
        }
        const statement = value as LivyStatement;
        if (
          typeof statement.code !== "string" ||
          !statement.code.includes(marker) ||
          !statement.code.includes(hashMarker)
        ) {
          return [];
        }
        return [
          {
            statementId: readStatementId(
              statement.id,
              "Livy statement list entry",
            ),
            state: readState(statement.state, "Livy statement list entry"),
          },
        ];
      });
      if (matches.length === 0) {
        return { outcome: "none" };
      }
      if (matches.length === 1) {
        return { outcome: "single", ...matches[0]! };
      }
      return { outcome: "ambiguous", statements: matches };
  }

  async assessAmbiguousStatement(
    workspaceId: string,
    lakehouseId: string,
    request: AmbiguousStatementRecoveryRequest,
  ): Promise<AmbiguousStatementRecoveryResult> {
    const discovery = await this.discoverSessionsByExactName(
      workspaceId,
      lakehouseId,
      request.sessionName,
    );
    if (discovery.outcome === "none") {
      return {
        outcome: "fail-closed",
        reason:
          "No exact session was found, so the adapter cannot prove whether the session POST was accepted. Do not resubmit automatically.",
      };
    }

    if (discovery.outcome === "ambiguous") {
      return {
        outcome: "fail-closed",
        reason:
          "Multiple exact-name sessions were found. Shared checkpoint state is required to select one safely.",
      };
    }
    if (request.statementId === undefined) {
      return {
        outcome: "fail-closed",
        session: discovery.session,
        reason:
          "The session was found but no accepted statement ID is checkpointed. The adapter cannot prove whether the statement POST was accepted and will not resubmit it.",
      };
    }
    const statementPath = `${lakehouseLivySessionsPath(
      workspaceId,
      lakehouseId,
    )}/${encodeURIComponent(
      discovery.session.id,
    )}/statements/${encodeURIComponent(String(request.statementId))}`;
    const response = await this.client.request<LivyStatement>(
      "GET",
      statementPath,
    );
    if (!response.body) {
      return {
        outcome: "fail-closed",
        session: discovery.session,
        reason: "The checkpointed statement status response is empty.",
      };
    }
    let state: string;
    try {
      state = readState(response.body.state, "Livy statement");
    } catch (error) {
      return {
        outcome: "fail-closed",
        session: discovery.session,
        reason: sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    if (state === "available") {
      try {
        const result = readSuccessfulStatement(
          request.statementId,
          response.body,
        );
        const verification = request.operation
          ? verifyObservedTable(
              request.operation.logicalId,
              request.operation.desiredHash,
              request.operation.table,
              result.observation,
              request.operation.ownership,
            )
          : undefined;
        return {
          outcome: "completed",
          session: discovery.session,
          statementId: request.statementId,
          ...(verification ? { verification } : {}),
        };
      } catch (error) {
        return {
          outcome: "failed",
          session: discovery.session,
          statementId: request.statementId,
          reason: sanitizeDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }
    if (STATEMENT_FAILURE_STATES.has(state)) {
      return {
        outcome: "failed",
        session: discovery.session,
        statementId: request.statementId,
        reason: `Livy statement entered terminal state '${state}'${formatStatementError(
          response.body.output,
        )}.`,
      };
    }
    return {
      outcome: "monitor",
      session: discovery.session,
      statementId: request.statementId,
      state,
    };
  }

  async resumeAcceptedStatement(
    workspaceId: string,
    lakehouseId: string,
    sessionId: string,
    statementId: number,
    operation?: LakehouseTableCreateOperation,
  ): Promise<{
    statementId: number;
    verification?: LakehouseTableVerification;
  }> {
    const path = `${lakehouseLivySessionsPath(
      workspaceId,
      lakehouseId,
    )}/${encodeURIComponent(
      sessionId,
    )}/statements/${encodeURIComponent(String(statementId))}`;
    const response = await this.client.request<LivyStatement>("GET", path);
    if (!response.body) {
      throw new Error(
        `Livy statement '${statementId}' status response is empty.`,
      );
    }
    const result = await this.waitForStatement(
      path,
      statementId,
      response.body,
    );
    if (!operation) {
      return { statementId };
    }
    const verification = verifyObservedTable(
      operation.logicalId,
      operation.desiredHash,
      operation.table,
      result.observation,
      operation.ownership,
    );
    if (!verification.matches) {
      throw new Error(
        `Recovered Lakehouse table statement '${statementId}' did not verify: ${verification.differences.join(
          "; ",
        )}`,
      );
    }
    return { statementId, verification };
  }

  async deleteSessionById(
    workspaceId: string,
    lakehouseId: string,
    sessionId: string,
  ): Promise<void> {
    await this.client.request(
      "DELETE",
      `${lakehouseLivySessionsPath(
        workspaceId,
        lakehouseId,
      )}/${encodeURIComponent(sessionId)}`,
      {
        retryable: true,
        acceptedStatuses: [200, 404],
      },
    );
  }

  private async inspectTable(
    workspaceId: string,
    lakehouseId: string,
    session: ActiveSession,
    loaded: LoadedLakehouseTable,
    execution: LakehouseTablesExecutionContext,
    hooks: LakehouseTableExecutionHooks,
  ): Promise<LakehouseTableObservation> {
    return (
      await this.submitAndWaitForStatement(
        workspaceId,
        lakehouseId,
        session,
        generateObserveTablePySpark(loaded.table),
        execution,
        {
          purpose: "inspect",
          logicalId: loaded.logicalId,
        },
        hooks,
      )
    ).observation;
  }

  private async withSession<T>(
    workspaceId: string,
    lakehouseId: string,
    desiredHash: string,
    execution: LakehouseTablesExecutionContext,
    hooks: LakehouseTableExecutionHooks,
    operation: (session: ActiveSession) => Promise<T>,
  ): Promise<T> {
    let session: ActiveSession | undefined;
    let primaryError: unknown;
    try {
      session = await this.createSession(
        workspaceId,
        lakehouseId,
        desiredHash,
        execution,
        hooks,
      );
      await this.waitForSessionIdle(session);
      return await operation(session);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (session) {
        try {
          const cleanupContext: LakehouseSessionAcceptedContext = {
            workspaceId,
            lakehouseId,
            sessionName: session.name,
            sessionsPath: session.basePath,
            attemptId: execution.attemptId,
            requestHash: session.requestHash,
            submittedAt: session.submittedAt,
            sessionId: session.id,
          };
          await hooks.onSessionCleanupSubmitting?.(cleanupContext);
          await this.deleteSession(session);
          await hooks.onSessionCleanupComplete?.(cleanupContext);
        } catch (cleanupError) {
          if (primaryError !== undefined) {
            throw new AggregateError(
              [primaryError, cleanupError],
              `${sanitizeDiagnostic(
                primaryError instanceof Error
                  ? primaryError.message
                  : String(primaryError),
              )} Livy session cleanup also failed.`,
            );
          }
          throw cleanupError;
        }
      }
    }
  }

  private async createSession(
    workspaceId: string,
    lakehouseId: string,
    desiredHash: string,
    execution: LakehouseTablesExecutionContext,
    hooks: LakehouseTableExecutionHooks,
  ): Promise<ActiveSession> {
    const basePath = lakehouseLivySessionsPath(workspaceId, lakehouseId);
    const name = createLakehouseTablesSessionName(
      workspaceId,
      lakehouseId,
      desiredHash,
      execution,
    );
    const submitting = {
      workspaceId,
      lakehouseId,
      sessionName: name,
      sessionsPath: basePath,
      attemptId: execution.attemptId,
      requestHash: "",
      submittedAt: new Date(this.options.now()).toISOString(),
    };
    const configuration = this.options.sessionConfiguration ?? {};
    const body = {
      name,
      driverMemory: configuration.driverMemory ?? "28g",
      driverCores: configuration.driverCores ?? 4,
      executorMemory: configuration.executorMemory ?? "28g",
      executorCores: configuration.executorCores ?? 4,
      tags: {
        "fabric.deploy.attemptId": execution.attemptId,
        "fabric.deploy.desiredHash": desiredHash,
        "fabric.deploy.requestHash": "",
      },
      ...(configuration.conf === undefined
        ? {}
        : { conf: configuration.conf }),
    };
    submitting.requestHash = sha256(
      stableJson({
        ...body,
        tags: {
          ...body.tags,
          "fabric.deploy.requestHash": undefined,
        },
      }),
    );
    body.tags["fabric.deploy.requestHash"] = submitting.requestHash;
    await hooks.onSessionSubmitting?.(submitting);
    const response = await this.client.request<LivySession>(
      "POST",
      basePath,
      {
        retryable: false,
        acceptedStatuses: [202],
        body,
      },
    );
    const id = readSessionId(
      response.body?.id ?? response.body?.livyId,
      "Livy session",
    );
    const accepted = { ...submitting, sessionId: id };
    await hooks.onSessionAccepted?.(accepted);
    await hooks.onSessionCreated?.(accepted);
    return {
      id,
      name,
      basePath,
      requestHash: submitting.requestHash,
      submittedAt: submitting.submittedAt,
    };
  }

  private async waitForSessionIdle(session: ActiveSession): Promise<void> {
    const deadline = this.options.now() + this.options.sessionTimeoutMs;
    while (true) {
      const response = await this.client.request<LivySession>(
        "GET",
        `${session.basePath}/${encodeURIComponent(session.id)}`,
        { deadlineMs: deadline },
      );
      const state = readState(response.body?.state, "Livy session");
      if (state === "idle") {
        return;
      }
      if (SESSION_FAILURE_STATES.has(state)) {
        throw new Error(
          `Livy session '${session.id}' entered terminal state '${state}'${formatSessionLog(
            response.body?.log,
          )}.`,
        );
      }
      await this.sleepBeforeNextPoll(
        deadline,
        this.options.sessionPollIntervalMs,
        `Livy session '${session.id}' did not become idle before the timeout.`,
      );
    }
  }

  private async submitAndWaitForStatement(
    workspaceId: string,
    lakehouseId: string,
    session: ActiveSession,
    code: string,
    execution: LakehouseTablesExecutionContext,
    dispatch: StatementDispatch,
    hooks: LakehouseTableExecutionHooks,
  ): Promise<StatementExecutionResult> {
    const statementsPath = `${session.basePath}/${encodeURIComponent(
      session.id,
    )}/statements`;
    const codeHash = sha256(code);
    const submitting = {
      ...makeSubmittingStatementContext(
        workspaceId,
        lakehouseId,
        session,
        execution,
        dispatch,
      ),
      codeHash,
    };
    if (dispatch.operation) {
      await hooks.onOperationSubmitting?.({
        ...submitting,
        operation: dispatch.operation,
      });
    }
    await hooks.onStatementSubmitting?.(submitting);
    const decoratedCode = [
      `_fabric_deploy_statement_attempt_name = ${JSON.stringify(
        submitting.statementAttemptName,
      )}`,
      `_fabric_deploy_statement_code_hash = ${JSON.stringify(codeHash)}`,
      code,
    ].join("\n");
    const response = await this.client.request<LivyStatement>(
      "POST",
      statementsPath,
      {
        retryable: false,
        acceptedStatuses: [200],
        body: {
          code: decoratedCode,
          kind: "pyspark",
        },
      },
    );
    const statementId = readStatementId(
      response.body?.id,
      "Livy statement",
    );
    const accepted = { ...submitting, statementId };
    await hooks.onStatementAccepted?.(accepted);
    if (dispatch.operation) {
      await hooks.onOperationAccepted?.({
        ...accepted,
        operation: dispatch.operation,
      });
    }
    return this.waitForStatement(
      `${statementsPath}/${encodeURIComponent(String(statementId))}`,
      statementId,
      response.body,
    );
  }

  private async waitForStatement(
    statementPath: string,
    statementId: number,
    initial: LivyStatement | undefined,
  ): Promise<StatementExecutionResult> {
    const deadline = this.options.now() + this.options.statementTimeoutMs;
    let statement = initial;
    while (true) {
      if (statement && statement.state !== undefined) {
        const state = readState(statement.state, "Livy statement");
        if (state === "available") {
          return readSuccessfulStatement(statementId, statement);
        }
        if (STATEMENT_FAILURE_STATES.has(state)) {
          throw new Error(
            `Livy statement '${statementId}' entered terminal state '${state}'${formatStatementError(
              statement.output,
            )}.`,
          );
        }
      }
      await this.sleepBeforeNextPoll(
        deadline,
        this.options.statementPollIntervalMs,
        `Livy statement '${statementId}' did not complete before the timeout.`,
      );
      const response = await this.client.request<LivyStatement>(
        "GET",
        statementPath,
        { deadlineMs: deadline },
      );
      if (!response.body) {
        throw new Error(
          `Livy statement '${statementId}' status response is empty.`,
        );
      }
      statement = response.body;
    }
  }

  private async deleteSession(session: ActiveSession): Promise<void> {
    await this.client.request(
      "DELETE",
      `${session.basePath}/${encodeURIComponent(session.id)}`,
      {
        retryable: true,
        acceptedStatuses: [200, 404],
      },
    );
  }

  private async sleepBeforeNextPoll(
    deadline: number,
    interval: number,
    timeoutMessage: string,
  ): Promise<void> {
    const remaining = deadline - this.options.now();
    if (remaining <= 0) {
      throw new Error(timeoutMessage);
    }
    await this.options.sleep(Math.min(interval, remaining));
    if (this.options.now() >= deadline) {
      throw new Error(timeoutMessage);
    }
  }
}

export function createLakehouseTablesSessionName(
  workspaceId: string,
  lakehouseId: string,
  desiredHash: string,
  execution: LakehouseTablesExecutionContext,
): string {
  validateExecutionContext(execution);
  const digest = sha256(
    stableJson({
      workspaceId,
      lakehouseId,
      desiredHash,
      sourceHash: execution.sourceHash,
      attemptId: execution.attemptId,
    }),
  );
  return `fabric-deploy-tables-${digest.slice(0, 32)}`;
}

export function createLakehouseTableStatementAttemptName(
  sessionName: string,
  purpose: LakehouseStatementPurpose,
  logicalId: string,
  operationHash?: string,
): string {
  return `fabric-deploy-statement-${sha256(
    stableJson({
      sessionName,
      purpose,
      logicalId,
      operationHash: operationHash ?? null,
    }),
  ).slice(0, 32)}`;
}

export function buildLakehouseTableCreateOperations(
  definition: LoadedLakehouseTablesDefinition,
  execution: LakehouseTablesExecutionContext,
): LakehouseTableCreateOperation[] {
  validateExecutionContext(execution);
  return definition.tables.map((loaded, order) => {
    const operationHash = hashTableOperation(
      "create-table",
      loaded,
      execution,
    );
    const ownership = ownershipEvidence(loaded, execution);
    const ownedTable = withOwnershipProperties(loaded.table, ownership);
    return {
      kind: "create-table",
      operationId: `${loaded.logicalId}:${operationHash.slice(0, 16)}`,
      operationHash,
      order,
      logicalId: loaded.logicalId,
      desiredHash: loaded.desiredHash,
      identifier: tableIdentifier(loaded.table),
      ownership,
      table: loaded.table,
      ddl: generateCreateTableSql(ownedTable),
    };
  });
}

export function buildLakehouseTableAdoptionOperation(
  loaded: LoadedLakehouseTable,
  execution: LakehouseTablesExecutionContext,
): LakehouseTableAdoptionOperation {
  validateExecutionContext(execution);
  const operationHash = hashTableOperation(
    "adopt-table-ownership",
    loaded,
    execution,
  );
  return {
    kind: "adopt-table-ownership",
    operationId: `${loaded.logicalId}:${operationHash.slice(0, 16)}`,
    operationHash,
    logicalId: loaded.logicalId,
    desiredHash: loaded.desiredHash,
    identifier: tableIdentifier(loaded.table),
    ownership: ownershipEvidence(loaded, execution),
  };
}

export function generateCreateTableSql(
  table: CanonicalLakehouseTable,
): string {
  const columns = table.columns
    .map((column) => {
      const parts = [
        quoteSparkIdentifier(column.name),
        renderSparkDataType(column.dataType),
      ];
      if (!column.nullable) {
        parts.push("NOT NULL");
      }
      if (column.comment !== undefined) {
        parts.push(`COMMENT ${quoteSparkStringLiteral(column.comment)}`);
      }
      return `  ${parts.join(" ")}`;
    })
    .join(",\n");
  const clauses = [
    `CREATE TABLE IF NOT EXISTS ${quotedTableIdentifier(table)} (\n${columns}\n)`,
    "USING DELTA",
  ];
  if (table.partitionColumns.length > 0) {
    clauses.push(
      `PARTITIONED BY (${table.partitionColumns
        .map(quoteSparkIdentifier)
        .join(", ")})`,
    );
  }
  if (table.comment !== undefined) {
    clauses.push(`COMMENT ${quoteSparkStringLiteral(table.comment)}`);
  }
  const propertyKeys = Object.keys(table.properties).sort(
    compareCanonicalStrings,
  );
  if (propertyKeys.length > 0) {
    clauses.push(
      `TBLPROPERTIES (${propertyKeys
        .map(
          (key) =>
            `${quoteSparkStringLiteral(key)} = ${quoteSparkStringLiteral(
              table.properties[key]!,
            )}`,
        )
        .join(", ")})`,
    );
  }
  return clauses.join("\n");
}

export function quoteSparkIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

export function quoteSparkStringLiteral(value: string): string {
  validateSparkSqlLiteral(value, "Spark SQL literal");
  return `'${value.replaceAll("'", "''")}'`;
}

export function verifyObservedTable(
  logicalId: string,
  desiredHash: string,
  desired: CanonicalLakehouseTable,
  observation: LakehouseTableObservation,
  expectedOwnership: LakehouseTableOwnershipEvidence,
): LakehouseTableVerification {
  const identifier = tableIdentifier(desired);
  const structuralDifferences: string[] = [];
  let protocolCompatible = true;
  if (!observation.schemaExists) {
    structuralDifferences.push(`schema '${desired.schema}' is absent`);
  }
  if (!observation.exists) {
    structuralDifferences.push("table is absent");
  } else {
    if (observation.provider?.toLowerCase() !== "delta") {
      structuralDifferences.push(
        `provider is '${observation.provider ?? "<unknown>"}', expected 'delta'`,
      );
    }
    if (observation.managed !== true) {
      structuralDifferences.push(
        `table type is '${observation.tableType ?? "<unknown>"}', expected MANAGED`,
      );
    }
    compareColumns(desired.columns, observation.columns, structuralDifferences);
    compareStringArrays(
      "partition columns",
      desired.partitionColumns,
      observation.partitionColumns,
      structuralDifferences,
    );
    if (
      desired.comment !== undefined &&
      desired.comment !== observation.comment
    ) {
      structuralDifferences.push(
        `table comment is ${JSON.stringify(
          observation.comment ?? null,
        )}, expected ${JSON.stringify(desired.comment)}`,
      );
    }
    for (const [key, value] of Object.entries(desired.properties)) {
      const observedValue = observation.properties?.[key];
      if (observedValue !== value) {
        structuralDifferences.push(
          `property '${key}' is ${JSON.stringify(
            observedValue ?? null,
          )}, expected ${JSON.stringify(value)}`,
        );
      }
    }
    const protocolDifferences = compareDeltaProtocol(observation);
    protocolCompatible = protocolDifferences.length === 0;
    structuralDifferences.push(...protocolDifferences);
  }

  const ownershipState = classifyOwnership(
    observation.properties ?? {},
    expectedOwnership,
  );
  const ownershipDifferences =
    observation.exists && ownershipState !== "owned"
      ? [
          ownershipState === "unowned"
            ? "Fabric deployment ownership evidence is absent"
            : "Fabric deployment ownership evidence conflicts with the stable owner identity or canonical desired hash",
        ]
      : [];
  const differences = [
    ...structuralDifferences,
    ...ownershipDifferences,
  ];
  const structureMatches = structuralDifferences.length === 0;
  const ownershipMatches =
    observation.exists && ownershipState === "owned";
  const sanitizedObservation = sanitizeObservationMetadata(
    desired,
    observation,
  );

  return {
    logicalId,
    identifier,
    desiredHash,
    observedHash: hashManagedObservation(
      desired,
      observation,
      expectedOwnership,
    ),
    observation: sanitizedObservation,
    expectedOwnership,
    ownershipState,
    structureMatches,
    ownershipMatches,
    protocolCompatible,
    matches: structureMatches && ownershipMatches,
    differences,
  };
}

function generateCreateAndObservePySpark(
  operation: LakehouseTableCreateOperation,
): string {
  const schema = operation.table.schema;
  return [
    "import json",
    `_fabric_schema_name = ${JSON.stringify(schema)}`,
    `_fabric_schema_exists = bool(spark.catalog.databaseExists(_fabric_schema_name))`,
    `if not _fabric_schema_exists:`,
    `    raise RuntimeError("Required Lakehouse schema is absent: " + _fabric_schema_name)`,
    `spark.sql(${JSON.stringify(operation.ddl)})`,
    generateObservationBody(operation.table),
  ].join("\n");
}

function generateObserveTablePySpark(
  table: CanonicalLakehouseTable,
): string {
  return ["import json", generateObservationBody(table)].join("\n");
}

function generateObservationBody(table: CanonicalLakehouseTable): string {
  const identifier = tableIdentifier(table);
  const sqlIdentifier = quotedTableIdentifier(table);
  return `
_fabric_schema_name = ${JSON.stringify(table.schema)}
_fabric_identifier = ${JSON.stringify(identifier)}
_fabric_sql_identifier = ${JSON.stringify(sqlIdentifier)}
_fabric_schema_exists = bool(spark.catalog.databaseExists(_fabric_schema_name))
_fabric_result = {
    "schemaExists": bool(_fabric_schema_exists),
    "exists": bool(_fabric_schema_exists and spark.catalog.tableExists(_fabric_identifier))
}
if _fabric_result["exists"]:
    _fabric_catalog_table = spark.catalog.getTable(_fabric_identifier)
    _fabric_detail_rows = spark.sql("DESCRIBE DETAIL " + _fabric_sql_identifier).collect()
    if not _fabric_detail_rows:
        raise RuntimeError("DESCRIBE DETAIL returned no rows for " + _fabric_identifier)
    _fabric_detail = _fabric_detail_rows[0].asDict(recursive=True)
    _fabric_schema = spark.table(_fabric_identifier).schema.jsonValue()
    _fabric_columns = []
    for _fabric_field in _fabric_schema.get("fields", []):
        _fabric_metadata = _fabric_field.get("metadata") or {}
        _fabric_column = {
            "name": _fabric_field.get("name"),
            "dataType": _fabric_field.get("type"),
            "nullable": bool(_fabric_field.get("nullable", True))
        }
        if _fabric_metadata.get("comment") is not None:
            _fabric_column["comment"] = str(_fabric_metadata.get("comment"))
        _fabric_columns.append(_fabric_column)
    _fabric_properties = {}
    for _fabric_property in spark.sql("SHOW TBLPROPERTIES " + _fabric_sql_identifier).collect():
        _fabric_values = list(_fabric_property)
        if len(_fabric_values) >= 2:
            _fabric_properties[str(_fabric_values[0])] = str(_fabric_values[1])
    _fabric_result.update({
        "provider": str(_fabric_detail.get("format")) if _fabric_detail.get("format") is not None else None,
        "tableType": str(getattr(_fabric_catalog_table, "tableType", "")),
        "managed": str(getattr(_fabric_catalog_table, "tableType", "")).upper() == "MANAGED",
        "columns": _fabric_columns,
        "partitionColumns": [str(_fabric_value) for _fabric_value in (_fabric_detail.get("partitionColumns") or [])],
        "properties": _fabric_properties,
        "minReaderVersion": int(_fabric_detail.get("minReaderVersion")) if _fabric_detail.get("minReaderVersion") is not None else None,
        "minWriterVersion": int(_fabric_detail.get("minWriterVersion")) if _fabric_detail.get("minWriterVersion") is not None else None,
        "tableFeatures": sorted([str(_fabric_value) for _fabric_value in (_fabric_detail.get("tableFeatures") or [])])
    })
    if _fabric_detail.get("description") is not None:
        _fabric_result["comment"] = str(_fabric_detail.get("description"))
print(${JSON.stringify(RESULT_MARKER)} + json.dumps(_fabric_result, sort_keys=True, separators=(",", ":"), default=str))
`.trim();
}

function readSuccessfulStatement(
  statementId: number,
  statement: LivyStatement,
): StatementExecutionResult {
  const output = statement.output;
  if (!output) {
    throw new Error(
      `Livy statement '${statementId}' completed without an output payload.`,
    );
  }
  const status =
    typeof output.status === "string" ? output.status.toLowerCase() : "";
  if (status && status !== "ok") {
    throw new Error(
      `Livy statement '${statementId}' failed${formatStatementError(output)}.`,
    );
  }
  if (
    typeof output.ename === "string" ||
    typeof output.evalue === "string"
  ) {
    throw new Error(
      `Livy statement '${statementId}' failed${formatStatementError(output)}.`,
    );
  }
  const text = collectOutputText(output.data);
  return {
    statementId,
    observation: parseObservationMarker(text, statementId),
  };
}

function collectOutputText(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }
  return Object.entries(data as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string")
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([, value]) => value as string)
    .join("\n");
}

function parseObservationMarker(
  output: string,
  statementId: number,
): LakehouseTableObservation {
  const markerLines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(RESULT_MARKER));
  if (markerLines.length === 0) {
    throw new Error(
      `Livy statement '${statementId}' output is missing the Fabric table verification marker. Diagnostic: ${sanitizeDiagnostic(
        output,
      )}`,
    );
  }
  if (markerLines.length !== 1) {
    throw new Error(
      `Livy statement '${statementId}' output contains multiple Fabric table verification marker lines.`,
    );
  }
  const jsonText = markerLines[0]!.slice(RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      `Livy statement '${statementId}' returned an invalid Fabric table verification payload.`,
    );
  }
  return normalizeObservation(parsed, statementId);
}

function normalizeObservation(
  value: unknown,
  statementId: number,
): LakehouseTableObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Livy statement '${statementId}' verification payload must be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.schemaExists !== "boolean" ||
    typeof record.exists !== "boolean"
  ) {
    throw new Error(
      `Livy statement '${statementId}' verification payload is missing boolean schemaExists or exists.`,
    );
  }
  if (!record.exists) {
    return {
      schemaExists: record.schemaExists,
      exists: false,
    };
  }
  if (!Array.isArray(record.columns)) {
    throw new Error(
      `Livy statement '${statementId}' verification payload is missing columns.`,
    );
  }
  const columns = record.columns.map((column, index) => {
    if (
      column === null ||
      typeof column !== "object" ||
      Array.isArray(column)
    ) {
      throw new Error(
        `Livy statement '${statementId}' column ${index} is invalid.`,
      );
    }
    const values = column as Record<string, unknown>;
    if (
      typeof values.name !== "string" ||
      typeof values.nullable !== "boolean"
    ) {
      throw new Error(
        `Livy statement '${statementId}' column ${index} is missing name or nullable.`,
      );
    }
    return {
      name: values.name,
      dataType: normalizeObservedDataType(values.dataType),
      nullable: values.nullable,
      ...(typeof values.comment === "string"
        ? { comment: values.comment }
        : {}),
    };
  });
  const partitionColumns = readStringArray(
    record.partitionColumns,
    statementId,
    "partitionColumns",
  );
  const tableFeatures = readStringArray(
    record.tableFeatures,
    statementId,
    "tableFeatures",
  ).sort(compareCanonicalStrings);
  const properties = readStringRecord(
    record.properties,
    statementId,
    "properties",
  );
  return {
    schemaExists: record.schemaExists,
    exists: true,
    ...(typeof record.provider === "string"
      ? { provider: record.provider }
      : {}),
    ...(typeof record.tableType === "string"
      ? { tableType: record.tableType }
      : {}),
    managed: record.managed === true,
    columns,
    partitionColumns,
    ...(typeof record.comment === "string"
      ? { comment: record.comment }
      : {}),
    properties,
    ...(typeof record.minReaderVersion === "number"
      ? { minReaderVersion: record.minReaderVersion }
      : {}),
    ...(typeof record.minWriterVersion === "number"
      ? { minWriterVersion: record.minWriterVersion }
      : {}),
    tableFeatures,
  };
}

function compareDeltaProtocol(
  observation: LakehouseTableObservation,
): string[] {
  const differences: string[] = [];
  if (
    observation.minReaderVersion !==
    PHASE3_DELTA_PROTOCOL_POLICY.minReaderVersion
  ) {
    differences.push(
      `Delta minReaderVersion is ${JSON.stringify(
        observation.minReaderVersion ?? null,
      )}, expected ${PHASE3_DELTA_PROTOCOL_POLICY.minReaderVersion}`,
    );
  }
  if (
    observation.minWriterVersion !==
    PHASE3_DELTA_PROTOCOL_POLICY.minWriterVersion
  ) {
    differences.push(
      `Delta minWriterVersion is ${JSON.stringify(
        observation.minWriterVersion ?? null,
      )}, expected ${PHASE3_DELTA_PROTOCOL_POLICY.minWriterVersion}`,
    );
  }
  const features = observation.tableFeatures;
  if (!features) {
    differences.push("Delta tableFeatures metadata is unavailable");
  } else {
    const unsupported = features.filter(
      (feature) =>
        !PHASE3_DELTA_PROTOCOL_POLICY.allowedTableFeatures.includes(feature),
    );
    if (unsupported.length > 0) {
      differences.push(
        `Delta table features are not allowed in Phase 3: ${unsupported.join(
          ", ",
        )}`,
      );
    }
  }
  return differences;
}

function classifyOwnership(
  properties: Record<string, string>,
  expected: LakehouseTableOwnershipEvidence,
): LakehouseTableOwnershipState {
  const observed = RESERVED_OWNERSHIP_PROPERTIES.map(
    (key) => properties[key],
  );
  if (observed.every((value) => value === undefined)) {
    return "unowned";
  }
  if (
    LEGACY_OWNERSHIP_PROPERTIES.some(
      (key) => properties[key] !== undefined,
    )
  ) {
    return "conflicting";
  }
  if (
    properties[FABRIC_TABLE_OWNER_SCHEME_PROPERTY] ===
      expected.ownerScheme &&
    properties[FABRIC_TABLE_OWNER_ID_PROPERTY] === expected.ownerId &&
    properties[FABRIC_TABLE_DESIRED_HASH_PROPERTY] ===
      expected.desiredHash
  ) {
    return "owned";
  }
  return "conflicting";
}

function compareColumns(
  desired: CanonicalLakehouseTableColumn[],
  observed: CanonicalLakehouseTableColumn[] | undefined,
  differences: string[],
): void {
  if (!observed) {
    differences.push("column metadata is unavailable");
    return;
  }
  if (desired.length !== observed.length) {
    differences.push(
      `column count is ${observed.length}, expected ${desired.length}`,
    );
  }
  const count = Math.min(desired.length, observed.length);
  for (let index = 0; index < count; index += 1) {
    const expected = desired[index]!;
    const actual = observed[index]!;
    if (actual.name !== expected.name) {
      differences.push(
        `column ${index} name is '${actual.name}', expected '${expected.name}'`,
      );
    }
    if (actual.dataType !== expected.dataType) {
      differences.push(
        `column '${expected.name}' type is '${actual.dataType}', expected '${expected.dataType}'`,
      );
    }
    if (actual.nullable !== expected.nullable) {
      differences.push(
        `column '${expected.name}' nullable is ${actual.nullable}, expected ${expected.nullable}`,
      );
    }
    if (
      expected.comment !== undefined &&
      actual.comment !== expected.comment
    ) {
      differences.push(
        `column '${expected.name}' comment is ${JSON.stringify(
          actual.comment ?? null,
        )}, expected ${JSON.stringify(expected.comment)}`,
      );
    }
  }
}

function compareStringArrays(
  description: string,
  desired: string[],
  observed: string[] | undefined,
  differences: string[],
): void {
  if (
    !observed ||
    desired.length !== observed.length ||
    desired.some((value, index) => observed[index] !== value)
  ) {
    differences.push(
      `${description} are ${JSON.stringify(
        observed ?? null,
      )}, expected ${JSON.stringify(desired)}`,
    );
  }
}

function hashManagedObservation(
  desired: CanonicalLakehouseTable,
  observation: LakehouseTableObservation,
  expectedOwnership: LakehouseTableOwnershipEvidence,
): string {
  return sha256(
    stableJson({
      schemaExists: observation.schemaExists,
      exists: observation.exists,
      provider: observation.provider ?? null,
      tableType: observation.tableType ?? null,
      managed: observation.managed ?? null,
      columns:
        observation.columns?.map((column, index) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          comment:
            desired.columns[index]?.comment === undefined
              ? undefined
              : (column.comment ?? null),
        })) ?? null,
      partitionColumns: observation.partitionColumns ?? null,
      comment:
        desired.comment === undefined
          ? undefined
          : (observation.comment ?? null),
      properties: nullPrototypeRecord(
        [
          ...Object.keys(desired.properties),
          ...RESERVED_OWNERSHIP_PROPERTIES,
        ]
          .sort(compareCanonicalStrings)
          .map((key) => [
            key,
            observation.properties?.[key] ?? null,
          ]),
      ),
      expectedOwnership,
      minReaderVersion: observation.minReaderVersion ?? null,
      minWriterVersion: observation.minWriterVersion ?? null,
      tableFeatures: observation.tableFeatures ?? null,
    }),
  );
}

function hashVerificationState(
  tables: LakehouseTableVerification[],
): string {
  return sha256(
    stableJson(
      tables.map((table) => ({
        logicalId: table.logicalId,
        identifier: table.identifier,
        observedHash: table.observedHash,
      })),
    ),
  );
}

function hashTableOperation(
  _kind: LakehouseTableOperation["kind"],
  loaded: LoadedLakehouseTable,
  execution: LakehouseTablesExecutionContext,
): string {
  return sha256(
    stableJson({
      kind: "manage-table-ownership",
      logicalId: loaded.logicalId,
      sourceHash: execution.sourceHash,
      desiredHash: loaded.desiredHash,
      table: loaded.table,
    }),
  );
}

function sanitizeObservationMetadata(
  desired: CanonicalLakehouseTable,
  observation: LakehouseTableObservation,
): LakehouseTableObservation {
  const managedPropertyKeys = [
    ...Object.keys(desired.properties),
    ...RESERVED_OWNERSHIP_PROPERTIES,
  ].sort(compareCanonicalStrings);
  const properties = nullPrototypeStringRecord(
    managedPropertyKeys.flatMap((key) => {
      const value = observation.properties?.[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return {
    schemaExists: observation.schemaExists,
    exists: observation.exists,
    ...(observation.provider === undefined
      ? {}
      : { provider: observation.provider }),
    ...(observation.tableType === undefined
      ? {}
      : { tableType: observation.tableType }),
    ...(observation.managed === undefined
      ? {}
      : { managed: observation.managed }),
    ...(observation.columns === undefined
      ? {}
      : { columns: observation.columns }),
    ...(observation.partitionColumns === undefined
      ? {}
      : { partitionColumns: observation.partitionColumns }),
    ...(observation.comment === undefined
      ? {}
      : { comment: observation.comment }),
    properties,
    ...(observation.minReaderVersion === undefined
      ? {}
      : { minReaderVersion: observation.minReaderVersion }),
    ...(observation.minWriterVersion === undefined
      ? {}
      : { minWriterVersion: observation.minWriterVersion }),
    ...(observation.tableFeatures === undefined
      ? {}
      : { tableFeatures: observation.tableFeatures }),
  };
}

export function createLakehouseTableOwnerId(
  execution: Pick<
    LakehouseTablesExecutionContext,
    "deploymentId" | "bundleLogicalId" | "targetLakehouseLogicalId"
  >,
  tableLogicalId: string,
): string {
  return sha256(
    stableJson({
      scheme: FABRIC_TABLE_OWNER_SCHEME_V1,
      deploymentId: execution.deploymentId,
      bundleLogicalId: execution.bundleLogicalId,
      targetLakehouseLogicalId:
        execution.targetLakehouseLogicalId,
      tableLogicalId,
    }),
  );
}

function ownershipEvidence(
  loaded: LoadedLakehouseTable,
  execution: LakehouseTablesExecutionContext,
): LakehouseTableOwnershipEvidence {
  return {
    ownerScheme: FABRIC_TABLE_OWNER_SCHEME_V1,
    ownerId: createLakehouseTableOwnerId(
      execution,
      loaded.logicalId,
    ),
    desiredHash: loaded.desiredHash,
  };
}

function withOwnershipProperties(
  table: CanonicalLakehouseTable,
  ownership: LakehouseTableOwnershipEvidence,
): CanonicalLakehouseTable {
  return {
    ...table,
    properties: nullPrototypeStringRecord([
      ...Object.entries(table.properties),
      [
        FABRIC_TABLE_OWNER_SCHEME_PROPERTY,
        ownership.ownerScheme,
      ],
      [FABRIC_TABLE_OWNER_ID_PROPERTY, ownership.ownerId],
      [FABRIC_TABLE_DESIRED_HASH_PROPERTY, ownership.desiredHash],
    ]),
  };
}

function makeSubmittingStatementContext(
  workspaceId: string,
  lakehouseId: string,
  session: ActiveSession,
  _execution: LakehouseTablesExecutionContext,
  dispatch: StatementDispatch,
): Omit<LakehouseStatementSubmittingContext, "codeHash"> {
  return {
    workspaceId,
    lakehouseId,
    sessionId: session.id,
    sessionName: session.name,
    statementAttemptName:
      createLakehouseTableStatementAttemptName(
        session.name,
        dispatch.purpose,
        dispatch.logicalId,
        dispatch.operation?.operationHash,
      ),
    purpose: dispatch.purpose,
    logicalId: dispatch.logicalId,
    ...(dispatch.operation
      ? { operation: dispatch.operation }
      : {}),
  };
}

function makeAcceptedStatementContext(
  workspaceId: string,
  lakehouseId: string,
  session: ActiveSession,
  execution: LakehouseTablesExecutionContext,
  dispatch: StatementDispatch,
  statementId: number,
  codeHash: string,
): LakehouseStatementAcceptedContext {
  return {
    ...makeSubmittingStatementContext(
      workspaceId,
      lakehouseId,
      session,
      execution,
      dispatch,
    ),
    codeHash,
    statementId,
  };
}

function tableIdentifier(table: CanonicalLakehouseTable): string {
  return `${table.schema}.${table.name}`;
}

function quotedTableIdentifier(table: CanonicalLakehouseTable): string {
  return `${quoteSparkIdentifier(table.schema)}.${quoteSparkIdentifier(
    table.name,
  )}`;
}

function renderSparkDataType(value: string): string {
  const decimal = /^decimal\(([0-9]+),([0-9]+)\)$/.exec(value);
  if (decimal) {
    return `DECIMAL(${decimal[1]}, ${decimal[2]})`;
  }
  const types: Record<string, string> = {
    boolean: "BOOLEAN",
    tinyint: "TINYINT",
    smallint: "SMALLINT",
    int: "INT",
    bigint: "BIGINT",
    float: "FLOAT",
    double: "DOUBLE",
    string: "STRING",
    binary: "BINARY",
    date: "DATE",
    timestamp: "TIMESTAMP",
  };
  if (!Object.hasOwn(types, value)) {
    throw new Error(
      `Canonical Lakehouse table type '${value}' is not supported by the Phase 3A runtime.`,
    );
  }
  return types[value]!;
}

function normalizeObservedDataType(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Observed Spark column type must be a string.");
  }
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  const aliases: Record<string, string> = {
    boolean: "boolean",
    byte: "tinyint",
    tinyint: "tinyint",
    short: "smallint",
    smallint: "smallint",
    integer: "int",
    int: "int",
    long: "bigint",
    bigint: "bigint",
    float: "float",
    double: "double",
    string: "string",
    binary: "binary",
    date: "date",
    timestamp: "timestamp",
  };
  if (Object.hasOwn(aliases, normalized)) {
    return aliases[normalized]!;
  }
  if (/^decimal\([1-9][0-9]?,[0-9]+\)$/.test(normalized)) {
    return normalized;
  }
  return normalized;
}

function readStringArray(
  value: unknown,
  statementId: number,
  description: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Livy statement '${statementId}' ${description} payload is invalid.`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `Livy statement '${statementId}' ${description}[${index}] is invalid.`,
      );
    }
    return entry;
  });
}

function readStringRecord(
  value: unknown,
  statementId: number,
  description: string,
): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Livy statement '${statementId}' ${description} payload is invalid.`,
    );
  }
  const result = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (UNSAFE_RECORD_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `Livy statement '${statementId}' ${description} contains unsafe key '${key}'.`,
      );
    }
    if (typeof entry !== "string") {
      throw new Error(
        `Livy statement '${statementId}' ${description} '${key}' is not a string.`,
      );
    }
    result[key] = entry;
  }
  return result;
}

function nullPrototypeStringRecord(
  entries: Iterable<readonly [string, string]>,
): Record<string, string> {
  return nullPrototypeRecord(entries);
}

function nullPrototypeRecord<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  const result = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    if (UNSAFE_RECORD_KEYS.has(key.toLowerCase())) {
      throw new Error(`Unsafe record key '${key}' is not supported.`);
    }
    result[key] = value;
  }
  return result;
}

function lakehouseLivySessionsPath(
  workspaceId: string,
  lakehouseId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/lakehouses/${encodeURIComponent(
    lakehouseId,
  )}/livyApi/versions/${LIVY_API_VERSION}/sessions`;
}

function readSessionId(value: unknown, description: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${description} response is missing its identifier.`);
  }
  return value;
}

function readStatementId(value: unknown, description: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${description} response is missing its identifier.`);
  }
  return value;
}

function readSessionRecoveryMetadata(
  session: LivySession,
): Pick<
  DiscoveredLakehouseLivySession,
  "attemptId" | "requestHash" | "submittedAt"
> {
  const tags =
    session.tags !== null &&
    typeof session.tags === "object" &&
    !Array.isArray(session.tags)
      ? (session.tags as Record<string, unknown>)
      : {};
  return {
    ...(typeof tags["fabric.deploy.attemptId"] === "string"
      ? { attemptId: tags["fabric.deploy.attemptId"] }
      : {}),
    ...(typeof tags["fabric.deploy.requestHash"] === "string"
      ? { requestHash: tags["fabric.deploy.requestHash"] }
      : {}),
    ...(typeof session.submittedDateTime === "string" &&
    !Number.isNaN(Date.parse(session.submittedDateTime))
      ? { submittedAt: session.submittedDateTime }
      : {}),
  };
}

function readState(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} response is missing its state.`);
  }
  return value.toLowerCase();
}

function formatSessionLog(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const lines = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return lines.length > 0
    ? `: ${sanitizeDiagnostic(lines.join("\n"))}`
    : "";
}

function formatStatementError(
  output: LivyStatementOutput | null | undefined,
): string {
  if (!output) {
    return "";
  }
  const parts: string[] = [];
  if (typeof output.ename === "string") {
    parts.push(output.ename);
  }
  if (typeof output.evalue === "string") {
    parts.push(output.evalue);
  }
  if (Array.isArray(output.traceback)) {
    parts.push(
      ...output.traceback.filter(
        (entry): entry is string => typeof entry === "string",
      ),
    );
  }
  return parts.length > 0
    ? `: ${sanitizeDiagnostic(parts.join("\n"))}`
    : "";
}

function sanitizeDiagnostic(value: string, maximum = 1_000): string {
  const sanitized = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\b(Bearer|access_token|client_secret|sig)\s*[:=]?\s*[A-Za-z0-9._~+/=-]+/gi,
      "$1=***",
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length <= maximum
    ? sanitized
    : `${sanitized.slice(0, maximum)}…`;
}

function validateExecutionContext(
  execution: LakehouseTablesExecutionContext,
): void {
  if (!HASH_PATTERN.test(execution.sourceHash)) {
    throw new Error(
      "LakehouseTables execution sourceHash must be a lowercase SHA-256 hash.",
    );
  }
  if (!ATTEMPT_ID_PATTERN.test(execution.attemptId)) {
    throw new Error(
      "LakehouseTables execution attemptId must be a safe non-empty identifier.",
    );
  }
  for (const [name, value] of [
    ["deploymentId", execution.deploymentId],
    ["bundleLogicalId", execution.bundleLogicalId],
    [
      "targetLakehouseLogicalId",
      execution.targetLakehouseLogicalId,
    ],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)
    ) {
      throw new Error(
        `LakehouseTables execution ${name} must be a safe non-empty stable ownership component.`,
      );
    }
  }
}

function validatePositiveOption(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
}
