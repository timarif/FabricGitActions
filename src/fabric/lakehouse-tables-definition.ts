import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import { substituteVariables } from "../substitution";

const TABLES_API_VERSION = "fabric.deploy/tables/v1alpha1";
const TABLES_KIND = "LakehouseTables";
const LOGICAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SQL_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const TABLE_FILE_PATTERN = /^tables\/[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;
const TEMPLATE_PATTERN = /\$\{/;
const UNSAFE_RECORD_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const RESERVED_IDENTIFIERS = new Set([
  "as",
  "by",
  "comment",
  "create",
  "delta",
  "exists",
  "if",
  "location",
  "not",
  "null",
  "options",
  "or",
  "partitioned",
  "replace",
  "table",
  "tblproperties",
  "using",
]);
const RESERVED_MANAGED_SCHEMA_NAMES = new Set([
  "default",
  "dbo",
  "information_schema",
  "sys",
]);

const DATA_TYPE_ALIASES: Record<string, string> = {
  boolean: "boolean",
  tinyint: "tinyint",
  smallint: "smallint",
  int: "int",
  integer: "int",
  bigint: "bigint",
  float: "float",
  double: "double",
  string: "string",
  binary: "binary",
  date: "date",
  timestamp: "timestamp",
};

export interface CanonicalLakehouseTableColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  comment?: string;
}

export interface CanonicalLakehouseTable {
  schema: string;
  name: string;
  provider: "delta";
  managed: true;
  columns: CanonicalLakehouseTableColumn[];
  partitionColumns: string[];
  comment?: string;
  properties: Record<string, string>;
}

export interface LoadedLakehouseTable {
  logicalId: string;
  file: string;
  dependsOn: string[];
  sql: string;
  table: CanonicalLakehouseTable;
  desiredHash: string;
}

export interface LoadedLakehouseSchema {
  logicalId: string;
  name: string;
  desiredHash: string;
}

export interface LoadedLakehouseTablesDefinition {
  apiVersion: typeof TABLES_API_VERSION;
  kind: typeof TABLES_KIND;
  defaultSchema?: string;
  adoptExisting: boolean;
  schemas?: LoadedLakehouseSchema[];
  tables: LoadedLakehouseTable[];
  sourceHash: string;
  desiredHash: string;
}

export interface ParseLakehouseTableSqlOptions {
  defaultSchema?: string;
  sourceName?: string;
}

interface TablesManifestEntry {
  logicalId: string;
  file: string;
  dependsOn: string[];
}

interface SchemasManifestEntry {
  logicalId: string;
  name: string;
}

interface ValidatedTablesManifest {
  defaultSchema?: string;
  adoptExisting: boolean;
  schemas: SchemasManifestEntry[];
  tables: TablesManifestEntry[];
}

type TokenKind =
  | "word"
  | "number"
  | "string"
  | "quotedIdentifier"
  | "symbol"
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
}

export function loadLakehouseTablesDefinition(
  itemDirectory: string,
  variables: Record<string, string> = {},
): LoadedLakehouseTablesDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const manifestPath = path.join(definitionDirectory, "tables.yaml");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(
      `LakehouseTables definition requires definition/tables.yaml.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error("LakehouseTables definition/tables.yaml is not valid YAML.");
  }
  const resolved = substituteVariables(parsed, variables);
  assertNoTemplateSyntax(resolved, "definition/tables.yaml");
  const manifest = validateManifest(resolved);

  const tablesDirectory = path.join(definitionDirectory, "tables");
  validateTablesDirectory(tablesDirectory, manifest.tables);
  const schemas = manifest.schemas
    .map((schema) => ({
      logicalId: schema.logicalId,
      name: schema.name,
      desiredHash: hashCanonicalLakehouseSchema(schema.name),
    }))
    .sort(
      (left, right) =>
        compareCanonicalStrings(left.name, right.name) ||
        compareCanonicalStrings(left.logicalId, right.logicalId),
    );

  const loadedByLogicalId = new Map<string, LoadedLakehouseTable>();
  const identifiers = new Map<string, string>();
  for (const entry of manifest.tables) {
    const sqlPath = resolveTableFile(
      definitionDirectory,
      tablesDirectory,
      entry.file,
    );
    const unresolvedSql = readFileSync(sqlPath, "utf8");
    const resolvedSql = substituteVariables(
      unresolvedSql,
      variables,
    ) as string;
    if (TEMPLATE_PATTERN.test(resolvedSql)) {
      throw new Error(
        `Lakehouse table '${entry.logicalId}' contains unresolved template syntax.`,
      );
    }
    const table = parseLakehouseTableSql(resolvedSql, {
      defaultSchema: manifest.defaultSchema,
      sourceName: entry.file,
    });
    const identifier = `${table.schema}.${table.name}`;
    const existing = identifiers.get(identifier);
    if (existing) {
      throw new Error(
        `Lakehouse tables '${existing}' and '${entry.logicalId}' both declare '${identifier}'.`,
      );
    }
    identifiers.set(identifier, entry.logicalId);
    loadedByLogicalId.set(entry.logicalId, {
      logicalId: entry.logicalId,
      file: entry.file,
      dependsOn: sortCanonical(entry.dependsOn),
      sql: resolvedSql,
      table,
      desiredHash: hashCanonicalLakehouseTable(table),
    });
  }

  const orderedTables = sortTablesByDependencies(
    manifest.tables,
    loadedByLogicalId,
  );
  const desiredHash = sha256(
    stableJson({
      apiVersion: TABLES_API_VERSION,
      kind: TABLES_KIND,
      defaultSchema: manifest.defaultSchema ?? null,
      adoptExisting: manifest.adoptExisting,
      ...(schemas.length === 0
        ? {}
        : {
            schemas: schemas.map((schema) => ({
              logicalId: schema.logicalId,
              name: schema.name,
            })),
          }),
      tables: orderedTables.map((table) => ({
        logicalId: table.logicalId,
        dependsOn: table.dependsOn,
        table: table.table,
      })),
    }),
  );
  const sourceHash = sha256(
    stableJson({
      apiVersion: TABLES_API_VERSION,
      kind: TABLES_KIND,
      defaultSchema: manifest.defaultSchema ?? null,
      adoptExisting: manifest.adoptExisting,
      ...(schemas.length === 0
        ? {}
        : {
            schemas: schemas.map((schema) => ({
              logicalId: schema.logicalId,
              name: schema.name,
            })),
          }),
      tables: orderedTables.map((table) => ({
        logicalId: table.logicalId,
        file: table.file,
        dependsOn: table.dependsOn,
        sql: table.sql,
      })),
    }),
  );

  return {
    apiVersion: TABLES_API_VERSION,
    kind: TABLES_KIND,
    ...(manifest.defaultSchema === undefined
      ? {}
      : { defaultSchema: manifest.defaultSchema }),
    adoptExisting: manifest.adoptExisting,
    ...(schemas.length === 0 ? {} : { schemas }),
    tables: orderedTables,
    sourceHash,
    desiredHash,
  };
}

export function parseLakehouseTableSql(
  sql: string,
  options: ParseLakehouseTableSqlOptions = {},
): CanonicalLakehouseTable {
  if (TEMPLATE_PATTERN.test(sql)) {
    throw new Error(
      `${options.sourceName ?? "Lakehouse table SQL"} contains unresolved template syntax.`,
    );
  }
  const defaultSchema =
    options.defaultSchema === undefined
      ? undefined
      : validateSqlIdentifier(
          options.defaultSchema,
          "defaultSchema",
          options.sourceName,
        );
  const parser = new RestrictedCreateTableParser(
    tokenize(sql, options.sourceName),
    defaultSchema,
    options.sourceName,
  );
  return parser.parse();
}

export function hashCanonicalLakehouseTable(
  table: CanonicalLakehouseTable,
): string {
  return sha256(stableJson(table));
}

export function hashCanonicalLakehouseSchema(name: string): string {
  return sha256(stableJson({ name }));
}

function validateManifest(value: unknown): ValidatedTablesManifest {
  const object = requireObject(value, "definition/tables.yaml");
  assertOnlyProperties(
    object,
    [
      "apiVersion",
      "kind",
      "defaultSchema",
      "adoptExisting",
      "schemas",
      "tables",
    ],
    "definition/tables.yaml",
  );
  if (object.apiVersion !== TABLES_API_VERSION) {
    throw new Error(
      `LakehouseTables apiVersion must be '${TABLES_API_VERSION}'.`,
    );
  }
  if (object.kind !== TABLES_KIND) {
    throw new Error(`LakehouseTables kind must be '${TABLES_KIND}'.`);
  }
  const defaultSchema =
    object.defaultSchema === undefined
      ? undefined
      : validateSqlIdentifier(
          requireString(object.defaultSchema, "defaultSchema"),
          "defaultSchema",
        );
  if (
    object.adoptExisting !== undefined &&
    typeof object.adoptExisting !== "boolean"
  ) {
    throw new Error("LakehouseTables adoptExisting must be a boolean.");
  }
  if (
    object.schemas !== undefined &&
    !Array.isArray(object.schemas)
  ) {
    throw new Error("LakehouseTables schemas must be an array.");
  }
  if (
    object.tables !== undefined &&
    !Array.isArray(object.tables)
  ) {
    throw new Error("LakehouseTables tables must be an array.");
  }
  const schemaValues = Array.isArray(object.schemas)
    ? object.schemas
    : [];
  const tableValues = Array.isArray(object.tables)
    ? object.tables
    : [];
  if (schemaValues.length === 0 && tableValues.length === 0) {
    throw new Error(
      "LakehouseTables must declare at least one schema or table.",
    );
  }

  const logicalIds = new Set<string>();
  const schemaNames = new Set<string>();
  const schemas = schemaValues.map((entry, index) => {
    const description = `LakehouseTables schemas[${index}]`;
    const schema = requireObject(entry, description);
    assertOnlyProperties(
      schema,
      ["logicalId", "name"],
      description,
    );
    const logicalId = validateManifestLogicalId(
      schema.logicalId,
      `${description}.logicalId`,
    );
    if (logicalIds.has(logicalId)) {
      throw new Error(
        `Duplicate Lakehouse DDL logicalId '${logicalId}'.`,
      );
    }
    logicalIds.add(logicalId);
    const name = validateSqlIdentifier(
      requireString(schema.name, `${description}.name`),
      `${description}.name`,
    );
    if (RESERVED_MANAGED_SCHEMA_NAMES.has(name)) {
      throw new Error(
        `${description}.name '${name}' is a reserved Lakehouse schema and cannot be managed.`,
      );
    }
    if (schemaNames.has(name)) {
      throw new Error(
        `Duplicate managed Lakehouse schema name '${name}'.`,
      );
    }
    schemaNames.add(name);
    return { logicalId, name };
  });

  const files = new Set<string>();
  const tableLogicalIds = new Set<string>();
  const tables = tableValues.map((entry, index) => {
    const description = `LakehouseTables tables[${index}]`;
    const table = requireObject(entry, description);
    assertOnlyProperties(
      table,
      ["logicalId", "file", "dependsOn"],
      description,
    );
    const logicalId = validateManifestLogicalId(
      table.logicalId,
      `${description}.logicalId`,
    );
    if (logicalIds.has(logicalId)) {
      throw new Error(
        `Duplicate Lakehouse DDL logicalId '${logicalId}'.`,
      );
    }
    logicalIds.add(logicalId);
    tableLogicalIds.add(logicalId);

    const file = requireString(table.file, `${description}.file`);
    if (!TABLE_FILE_PATTERN.test(file)) {
      throw new Error(
        `${description}.file must match 'tables/*.sql' and use a single safe file name.`,
      );
    }
    if (files.has(file)) {
      throw new Error(`Duplicate Lakehouse table file '${file}'.`);
    }
    files.add(file);

    const dependsOn = validateDependenciesValue(
      table.dependsOn,
      `${description}.dependsOn`,
    );
    return { logicalId, file, dependsOn };
  });

  for (const table of tables) {
    const seen = new Set<string>();
    for (const dependency of table.dependsOn) {
      if (dependency === table.logicalId) {
        throw new Error(
          `Lakehouse table '${table.logicalId}' cannot depend on itself.`,
        );
      }
      if (!tableLogicalIds.has(dependency)) {
        throw new Error(
          `Lakehouse table '${table.logicalId}' depends on unknown table '${dependency}'.`,
        );
      }
      if (seen.has(dependency)) {
        throw new Error(
          `Lakehouse table '${table.logicalId}' repeats dependency '${dependency}'.`,
        );
      }
      seen.add(dependency);
    }
  }

  return {
    ...(defaultSchema === undefined ? {} : { defaultSchema }),
    adoptExisting: object.adoptExisting === true,
    schemas,
    tables,
  };
}

function validateTablesDirectory(
  tablesDirectory: string,
  entries: TablesManifestEntry[],
): void {
  if (
    !existsSync(tablesDirectory) ||
    !statSync(tablesDirectory).isDirectory()
  ) {
    if (entries.length === 0) {
      return;
    }
    throw new Error(
      "LakehouseTables definition requires a definition/tables directory.",
    );
  }
  const declared = new Set(
    entries.map((entry) => path.basename(entry.file)),
  );
  const actual = new Set<string>();
  for (const entry of readdirSync(tablesDirectory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(tablesDirectory, entry.name);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `LakehouseTables definition/tables/${entry.name} must not be a symbolic link or junction.`,
      );
    }
    if (!stats.isFile() || !entry.name.endsWith(".sql")) {
      throw new Error(
        `LakehouseTables definition/tables may contain only declared .sql files.`,
      );
    }
    actual.add(entry.name);
  }
  for (const file of actual) {
    if (!declared.has(file)) {
      throw new Error(
        `LakehouseTables SQL file 'tables/${file}' is not declared in tables.yaml.`,
      );
    }
  }
  for (const file of declared) {
    if (!actual.has(file)) {
      throw new Error(
        `LakehouseTables declared SQL file 'tables/${file}' does not exist.`,
      );
    }
  }
}

function resolveTableFile(
  definitionDirectory: string,
  tablesDirectory: string,
  relativeFile: string,
): string {
  const filePath = path.resolve(
    definitionDirectory,
    ...relativeFile.split("/"),
  );
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(
      `LakehouseTables declared SQL file '${relativeFile}' does not exist.`,
    );
  }
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `LakehouseTables SQL file '${relativeFile}' must not be a symbolic link or junction.`,
    );
  }
  const realTablesDirectory = realpathSync(tablesDirectory);
  const realFilePath = realpathSync(filePath);
  if (!isContainedPath(realTablesDirectory, realFilePath)) {
    throw new Error(
      `LakehouseTables SQL file '${relativeFile}' resolves outside definition/tables.`,
    );
  }
  return realFilePath;
}

function sortTablesByDependencies(
  manifestTables: TablesManifestEntry[],
  loaded: Map<string, LoadedLakehouseTable>,
): LoadedLakehouseTable[] {
  const manifestById = new Map(
    manifestTables.map((table) => [table.logicalId, table]),
  );
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const table of manifestTables) {
    indegree.set(table.logicalId, table.dependsOn.length);
    for (const dependency of table.dependsOn) {
      const values = dependents.get(dependency) ?? [];
      values.push(table.logicalId);
      dependents.set(dependency, values);
    }
  }

  const compareIds = (left: string, right: string): number => {
    const leftFile = manifestById.get(left)?.file ?? "";
    const rightFile = manifestById.get(right)?.file ?? "";
    return (
      compareCanonicalStrings(leftFile, rightFile) ||
      compareCanonicalStrings(left, right)
    );
  };
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([logicalId]) => logicalId)
    .sort(compareIds);
  const ordered: LoadedLakehouseTable[] = [];

  while (ready.length > 0) {
    const logicalId = ready.shift()!;
    const table = loaded.get(logicalId);
    if (!table) {
      throw new Error(
        `Lakehouse table '${logicalId}' was not loaded from its SQL file.`,
      );
    }
    ordered.push(table);
    for (const dependent of dependents.get(logicalId) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (ordered.length !== manifestTables.length) {
    const cycle = findDependencyCycle(manifestTables);
    throw new Error(
      `Lakehouse table dependency cycle detected${
        cycle.length > 0 ? `: ${cycle.join(" -> ")}` : ""
      }.`,
    );
  }
  return ordered;
}

function findDependencyCycle(tables: TablesManifestEntry[]): string[] {
  const byId = new Map(tables.map((table) => [table.logicalId, table]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(logicalId: string): string[] | undefined {
    if (visiting.has(logicalId)) {
      const start = stack.indexOf(logicalId);
      return [...stack.slice(start), logicalId];
    }
    if (visited.has(logicalId)) {
      return undefined;
    }
    visiting.add(logicalId);
    stack.push(logicalId);
    for (const dependency of byId.get(logicalId)?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(logicalId);
    visited.add(logicalId);
    return undefined;
  }

  for (const table of tables) {
    const cycle = visit(table.logicalId);
    if (cycle) {
      return cycle;
    }
  }
  return [];
}

class RestrictedCreateTableParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly defaultSchema: string | undefined,
    private readonly sourceName: string | undefined,
  ) {}

  parse(): CanonicalLakehouseTable {
    this.expectKeyword("CREATE");
    if (this.matchesKeyword("OR")) {
      this.fail("CREATE OR REPLACE is not supported.");
    }
    this.expectKeyword("TABLE");
    this.expectKeyword("IF");
    this.expectKeyword("NOT");
    this.expectKeyword("EXISTS");

    const firstName = this.parseIdentifier("table identifier");
    let schema: string;
    let name: string;
    if (this.consumeSymbol(".")) {
      schema = firstName;
      name = this.parseIdentifier("table name");
      if (this.matchesSymbol(".")) {
        this.fail("Three-part table names are not supported.");
      }
    } else {
      if (!this.defaultSchema) {
        this.fail(
          "Unqualified table names require defaultSchema in tables.yaml.",
        );
      }
      schema = this.defaultSchema;
      name = firstName;
    }

    this.expectSymbol("(");
    const columns = this.parseColumns();
    this.expectKeyword("USING");
    const provider = this.expectWord("table provider").toLowerCase();
    if (provider !== "delta") {
      this.fail("Only USING DELTA managed tables are supported.");
    }

    let partitionColumns: string[] = [];
    let comment: string | undefined;
    let properties: Record<string, string> = {};
    let sawPartitioned = false;
    let sawComment = false;
    let sawProperties = false;

    while (!this.matchesSymbol(";") && !this.matchesKind("eof")) {
      if (this.consumeKeyword("PARTITIONED")) {
        if (sawPartitioned) {
          this.fail("PARTITIONED BY may be specified only once.");
        }
        sawPartitioned = true;
        this.expectKeyword("BY");
        this.expectSymbol("(");
        partitionColumns = this.parseIdentifierList("partition column");
        this.expectSymbol(")");
        continue;
      }
      if (this.consumeKeyword("COMMENT")) {
        if (sawComment) {
          this.fail("Table COMMENT may be specified only once.");
        }
        sawComment = true;
        comment = this.expectSafeString("table comment");
        continue;
      }
      if (this.consumeKeyword("TBLPROPERTIES")) {
        if (sawProperties) {
          this.fail("TBLPROPERTIES may be specified only once.");
        }
        sawProperties = true;
        properties = this.parseProperties();
        continue;
      }
      const token = this.current();
      const keyword = token.value.toUpperCase();
      if (keyword === "LOCATION") {
        this.fail("LOCATION and external tables are not supported.");
      }
      if (keyword === "OPTIONS") {
        this.fail("OPTIONS is not supported.");
      }
      if (keyword === "AS") {
        this.fail("CREATE TABLE AS SELECT is not supported.");
      }
      this.fail(
        `Unsupported clause or token '${token.value}' after USING DELTA.`,
      );
    }

    if (this.consumeSymbol(";") && !this.matchesKind("eof")) {
      this.fail("Multiple SQL statements are not supported.");
    }
    this.expectKind("eof", "end of SQL statement");

    const columnNames = new Set(columns.map((column) => column.name));
    const seenPartitions = new Set<string>();
    for (const partitionColumn of partitionColumns) {
      if (!columnNames.has(partitionColumn)) {
        this.fail(
          `Partition column '${partitionColumn}' is not declared in the table.`,
        );
      }
      if (seenPartitions.has(partitionColumn)) {
        this.fail(`Partition column '${partitionColumn}' is duplicated.`);
      }
      seenPartitions.add(partitionColumn);
    }

    return {
      schema,
      name,
      provider: "delta",
      managed: true,
      columns,
      partitionColumns,
      ...(comment === undefined ? {} : { comment }),
      properties,
    };
  }

  private parseColumns(): CanonicalLakehouseTableColumn[] {
    if (this.matchesSymbol(")")) {
      this.fail("A Lakehouse table must declare at least one column.");
    }
    const columns: CanonicalLakehouseTableColumn[] = [];
    const names = new Set<string>();
    while (true) {
      const name = this.parseIdentifier("column name");
      if (names.has(name)) {
        this.fail(`Column '${name}' is declared more than once.`);
      }
      names.add(name);
      const dataType = this.parseDataType();
      let nullable = true;
      if (this.consumeKeyword("NOT")) {
        this.expectKeyword("NULL");
        nullable = false;
      } else {
        this.consumeKeyword("NULL");
      }
      const comment = this.consumeKeyword("COMMENT")
        ? this.expectSafeString("column comment")
        : undefined;
      columns.push({
        name,
        dataType,
        nullable,
        ...(comment === undefined ? {} : { comment }),
      });
      if (!this.consumeSymbol(",")) {
        break;
      }
      if (this.matchesSymbol(")")) {
        this.fail("Trailing commas in column declarations are not supported.");
      }
    }
    this.expectSymbol(")");
    return columns;
  }

  private parseDataType(): string {
    const typeName = this.expectWord("column data type").toLowerCase();
    if (typeName === "decimal") {
      this.expectSymbol("(");
      const precision = this.expectInteger("decimal precision");
      this.expectSymbol(",");
      const scale = this.expectInteger("decimal scale");
      this.expectSymbol(")");
      if (precision < 1 || precision > 38) {
        this.fail("DECIMAL precision must be between 1 and 38.");
      }
      if (scale < 0 || scale > precision) {
        this.fail(
          "DECIMAL scale must be between 0 and the declared precision.",
        );
      }
      return `decimal(${precision},${scale})`;
    }
    if (!Object.hasOwn(DATA_TYPE_ALIASES, typeName)) {
      this.fail(
        `Data type '${typeName}' is outside the Phase 3A scalar type allowlist.`,
      );
    }
    return DATA_TYPE_ALIASES[typeName]!;
  }

  private parseIdentifierList(description: string): string[] {
    if (this.matchesSymbol(")")) {
      this.fail(`${description} list must not be empty.`);
    }
    const values: string[] = [];
    while (true) {
      values.push(this.parseIdentifier(description));
      if (!this.consumeSymbol(",")) {
        break;
      }
    }
    return values;
  }

  private parseProperties(): Record<string, string> {
    this.expectSymbol("(");
    if (this.matchesSymbol(")")) {
      this.fail("TBLPROPERTIES must not be empty.");
    }
    const properties = Object.create(null) as Record<string, string>;
    const normalizedKeys = new Set<string>();
    while (true) {
      const key = this.expectSafeString("table property key");
      if (!key) {
        this.fail("Table property keys must not be empty.");
      }
      validateTablePropertyKey(key, this.sourceName);
      const normalizedKey = key.toLowerCase();
      if (normalizedKeys.has(normalizedKey)) {
        this.fail(`Table property '${key}' is declared more than once.`);
      }
      normalizedKeys.add(normalizedKey);
      this.expectSymbol("=");
      properties[key] = this.expectSafeString("table property value");
      if (!this.consumeSymbol(",")) {
        break;
      }
      if (this.matchesSymbol(")")) {
        this.fail("Trailing commas in TBLPROPERTIES are not supported.");
      }
    }
    this.expectSymbol(")");
    return properties;
  }

  private parseIdentifier(description: string): string {
    const token = this.current();
    if (token.kind !== "word" && token.kind !== "quotedIdentifier") {
      this.fail(`Expected ${description}, received '${token.value}'.`);
    }
    this.index += 1;
    return validateSqlIdentifier(
      token.value,
      description,
      this.sourceName,
    );
  }

  private expectInteger(description: string): number {
    const token = this.expectKind("number", description);
    const value = Number(token.value);
    if (!Number.isSafeInteger(value)) {
      this.fail(`${description} is outside the supported integer range.`);
    }
    return value;
  }

  private expectString(description: string): string {
    return this.expectKind("string", description).value;
  }

  private expectSafeString(description: string): string {
    const value = this.expectString(description);
    validateSparkSqlLiteral(value, description, this.sourceName);
    return value;
  }

  private expectWord(description: string): string {
    return this.expectKind("word", description).value;
  }

  private expectKeyword(keyword: string): void {
    if (!this.consumeKeyword(keyword)) {
      this.fail(
        `Expected keyword ${keyword}, received '${this.current().value}'.`,
      );
    }
  }

  private consumeKeyword(keyword: string): boolean {
    const token = this.current();
    if (
      token.kind === "word" &&
      token.value.toUpperCase() === keyword.toUpperCase()
    ) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchesKeyword(keyword: string): boolean {
    const token = this.current();
    return (
      token.kind === "word" &&
      token.value.toUpperCase() === keyword.toUpperCase()
    );
  }

  private expectSymbol(symbol: string): void {
    if (!this.consumeSymbol(symbol)) {
      this.fail(`Expected '${symbol}', received '${this.current().value}'.`);
    }
  }

  private consumeSymbol(symbol: string): boolean {
    const token = this.current();
    if (token.kind === "symbol" && token.value === symbol) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchesSymbol(symbol: string): boolean {
    const token = this.current();
    return token.kind === "symbol" && token.value === symbol;
  }

  private matchesKind(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private expectKind(kind: TokenKind, description: string): Token {
    const token = this.current();
    if (token.kind !== kind) {
      this.fail(`Expected ${description}, received '${token.value}'.`);
    }
    this.index += 1;
    return token;
  }

  private current(): Token {
    return this.tokens[this.index] ?? {
      kind: "eof",
      value: "<eof>",
      offset: 0,
    };
  }

  private fail(message: string): never {
    const prefix = this.sourceName ? `${this.sourceName}: ` : "";
    const token = this.current();
    throw new Error(`${prefix}${message} (offset ${token.offset})`);
  }
}

function tokenize(sql: string, sourceName?: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const start = index;
      index += 2;
      const end = sql.indexOf("*/", index);
      if (end === -1) {
        throw new Error(
          `${sourceName ? `${sourceName}: ` : ""}Unterminated block comment at offset ${start}.`,
        );
      }
      index = end + 2;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (
        index < sql.length &&
        /[A-Za-z0-9_]/.test(sql[index]!)
      ) {
        index += 1;
      }
      tokens.push({
        kind: "word",
        value: sql.slice(start, index),
        offset: start,
      });
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[0-9]/.test(sql[index]!)) {
        index += 1;
      }
      tokens.push({
        kind: "number",
        value: sql.slice(start, index),
        offset: start,
      });
      continue;
    }
    if (character === "'") {
      const start = index;
      index += 1;
      let value = "";
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          terminated = true;
          break;
        }
        value += sql[index]!;
        index += 1;
      }
      if (!terminated) {
        throw new Error(
          `${sourceName ? `${sourceName}: ` : ""}Unterminated string literal at offset ${start}.`,
        );
      }
      tokens.push({ kind: "string", value, offset: start });
      continue;
    }
    if (character === "`") {
      const start = index;
      index += 1;
      const end = sql.indexOf("`", index);
      if (end === -1) {
        throw new Error(
          `${sourceName ? `${sourceName}: ` : ""}Unterminated quoted identifier at offset ${start}.`,
        );
      }
      const value = sql.slice(index, end);
      index = end + 1;
      tokens.push({
        kind: "quotedIdentifier",
        value,
        offset: start,
      });
      continue;
    }
    if ("(),.;=".includes(character)) {
      tokens.push({
        kind: "symbol",
        value: character,
        offset: index,
      });
      index += 1;
      continue;
    }
    throw new Error(
      `${sourceName ? `${sourceName}: ` : ""}Unsupported character '${character}' at offset ${index}.`,
    );
  }

  tokens.push({ kind: "eof", value: "<eof>", offset: sql.length });
  return tokens;
}

function validateTablePropertyKey(
  key: string,
  sourceName?: string,
): void {
  const normalized = key.toLowerCase();
  if (UNSAFE_RECORD_KEYS.has(normalized)) {
    throw new Error(
      `${sourceName ? `${sourceName}: ` : ""}Table property '${key}' is unsafe and is not supported.`,
    );
  }
  if (
    normalized.startsWith("delta.") ||
    normalized.startsWith("spark.") ||
    normalized.startsWith("fabric.deploy.")
  ) {
    throw new Error(
      `${sourceName ? `${sourceName}: ` : ""}Table property '${key}' is reserved or can change runtime/Delta protocol behavior.`,
    );
  }
}

export function validateSparkSqlLiteral(
  value: string,
  description: string,
  sourceName?: string,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      value[index] === "\\" ||
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new Error(
        `${sourceName ? `${sourceName}: ` : ""}${description} contains an unsafe character at index ${index}. Backslashes, line breaks, control characters, and surrogate code units are not supported.`,
      );
    }
  }
}

function validateSqlIdentifier(
  value: string,
  description: string,
  sourceName?: string,
): string {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `${sourceName ? `${sourceName}: ` : ""}${description} '${value}' must be a lowercase ASCII identifier matching ${SQL_IDENTIFIER_PATTERN}.`,
    );
  }
  if (RESERVED_IDENTIFIERS.has(value)) {
    throw new Error(
      `${sourceName ? `${sourceName}: ` : ""}${description} '${value}' is reserved in the Phase 3A grammar.`,
    );
  }
  return value;
}

function validateManifestLogicalId(
  value: unknown,
  description: string,
): string {
  const logicalId = requireString(value, description);
  if (!LOGICAL_ID_PATTERN.test(logicalId)) {
    throw new Error(`${description} '${logicalId}' is invalid.`);
  }
  return logicalId;
}

function validateDependenciesValue(
  value: unknown,
  description: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array.`);
  }
  return value.map((dependency, index) => {
    const logicalId = requireString(
      dependency,
      `${description}[${index}]`,
    );
    if (!LOGICAL_ID_PATTERN.test(logicalId)) {
      throw new Error(
        `${description}[${index}] '${logicalId}' is invalid.`,
      );
    }
    return logicalId;
  });
}

function requireObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value;
}

function assertOnlyProperties(
  value: Record<string, unknown>,
  allowed: string[],
  description: string,
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter(
    (property) => !allowedSet.has(property),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${description} contains unsupported propert${
        unsupported.length === 1 ? "y" : "ies"
      }: ${sortCanonical(unsupported).join(", ")}.`,
    );
  }
}

function assertNoTemplateSyntax(
  value: unknown,
  description: string,
): void {
  if (typeof value === "string") {
    if (TEMPLATE_PATTERN.test(value)) {
      throw new Error(`${description} contains unresolved template syntax.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoTemplateSyntax(entry, description));
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach((entry) =>
      assertNoTemplateSyntax(entry, description),
    );
  }
}

function sortCanonical(values: string[]): string[] {
  return [...values].sort(compareCanonicalStrings);
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}
