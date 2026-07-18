import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  hashCanonicalLakehouseTable,
  loadLakehouseTablesDefinition,
  parseLakehouseTableSql,
} from "../src/fabric/lakehouse-tables-definition";

interface TableEntry {
  logicalId: string;
  file: string;
  dependsOn?: string[];
}

interface SchemaEntry {
  logicalId: string;
  name: string;
}

function createDefinition(
  tables: TableEntry[],
  sqlFiles: Record<string, string>,
  options: {
    defaultSchema?: string;
    adoptExisting?: boolean;
    schemas?: SchemaEntry[];
    variables?: Record<string, string>;
    extraManifest?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-lakehouse-tables-"));
  const itemDirectory = path.join(root, "tables-item");
  const definitionDirectory = path.join(itemDirectory, "definition");
  const tablesDirectory = path.join(definitionDirectory, "tables");
  mkdirSync(tablesDirectory, { recursive: true });
  writeFileSync(
    path.join(definitionDirectory, "tables.yaml"),
    stringify({
      apiVersion: "fabric.deploy/tables/v1alpha1",
      kind: "LakehouseTables",
      ...(options.defaultSchema === undefined
        ? {}
        : { defaultSchema: options.defaultSchema }),
      ...(options.adoptExisting === undefined
        ? {}
        : { adoptExisting: options.adoptExisting }),
      ...(options.schemas === undefined
        ? {}
        : { schemas: options.schemas }),
      tables,
      ...(options.extraManifest ?? {}),
    }),
    "utf8",
  );
  for (const [file, sql] of Object.entries(sqlFiles)) {
    writeFileSync(path.join(tablesDirectory, file), sql, "utf8");
  }
  return {
    itemDirectory,
    variables: options.variables ?? {},
  };
}

const ORDERS_SQL = `
-- A leading source comment is ignored semantically.
CREATE TABLE IF NOT EXISTS \`sales\`.\`orders\` (
  \`order_id\` BIGINT NOT NULL COMMENT 'Source order identifier',
  \`order_date\` DATE,
  \`amount\` DECIMAL(18, 2),
  \`description\` STRING
)
USING DELTA
PARTITIONED BY (\`order_date\`)
COMMENT 'Sales orders'
TBLPROPERTIES (
  'data.layer' = 'silver',
  'note' = 'a semicolon; inside a string'
);
`;

describe("LakehouseTables source definitions", () => {
  it("loads deterministic schema declarations before tables", () => {
    const input = createDefinition(
      [
        {
          logicalId: "orders",
          file: "tables/orders.sql",
        },
      ],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
      {
        schemas: [
          { logicalId: "zetaSchema", name: "zeta" },
          { logicalId: "salesSchema", name: "sales" },
        ],
      },
    );

    const definition = loadLakehouseTablesDefinition(
      input.itemDirectory,
    );

    expect(definition.schemas).toEqual([
      {
        logicalId: "salesSchema",
        name: "sales",
        desiredHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        logicalId: "zetaSchema",
        name: "zeta",
        desiredHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it("supports schema-only bundles and preserves tables-only hashes", () => {
    const schemaOnly = createDefinition([], {}, {
      schemas: [{ logicalId: "salesSchema", name: "sales" }],
    });
    rmSync(
      path.join(schemaOnly.itemDirectory, "definition", "tables"),
      { recursive: true },
    );
    const schemaDefinition = loadLakehouseTablesDefinition(
      schemaOnly.itemDirectory,
    );
    expect(schemaDefinition.tables).toEqual([]);
    expect(schemaDefinition.schemas).toHaveLength(1);

    const tablesOnly = createDefinition(
      [{ logicalId: "orders", file: "tables/orders.sql" }],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
    );
    const explicitEmptySchemas = createDefinition(
      [{ logicalId: "orders", file: "tables/orders.sql" }],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
      { schemas: [] },
    );
    const first = loadLakehouseTablesDefinition(
      tablesOnly.itemDirectory,
    );
    const second = loadLakehouseTablesDefinition(
      explicitEmptySchemas.itemDirectory,
    );
    expect(first.schemas).toBeUndefined();
    expect(first.desiredHash).toBe(second.desiredHash);
    expect(first.sourceHash).toBe(second.sourceHash);
  });

  it("requires at least one schema or table", () => {
    const input = createDefinition([], {}, { schemas: [] });
    expect(() =>
      loadLakehouseTablesDefinition(input.itemDirectory),
    ).toThrow("at least one schema or table");
  });

  it("rejects reserved, duplicate, and colliding schema declarations", () => {
    for (const name of ["dbo", "sys", "information_schema", "default"]) {
      const input = createDefinition([], {}, {
        schemas: [{ logicalId: "managedSchema", name }],
      });
      expect(() =>
        loadLakehouseTablesDefinition(input.itemDirectory),
      ).toThrow("reserved Lakehouse schema");
    }

    const duplicateName = createDefinition([], {}, {
      schemas: [
        { logicalId: "firstSchema", name: "sales" },
        { logicalId: "secondSchema", name: "sales" },
      ],
    });
    expect(() =>
      loadLakehouseTablesDefinition(duplicateName.itemDirectory),
    ).toThrow("Duplicate managed Lakehouse schema name");

    const logicalCollision = createDefinition(
      [{ logicalId: "salesSchema", file: "tables/orders.sql" }],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
      {
        schemas: [{ logicalId: "salesSchema", name: "sales" }],
      },
    );
    expect(() =>
      loadLakehouseTablesDefinition(logicalCollision.itemDirectory),
    ).toThrow("Duplicate Lakehouse DDL logicalId");
  });

  it("loads, canonicalizes, hashes, and dependency-sorts table definitions", () => {
    const input = createDefinition(
      [
        {
          logicalId: "orderLines",
          file: "tables/020-order-lines.sql",
          dependsOn: ["orders"],
        },
        {
          logicalId: "orders",
          file: "tables/010-orders.sql",
        },
      ],
      {
        "010-orders.sql": ORDERS_SQL,
        "020-order-lines.sql": `
          CREATE TABLE IF NOT EXISTS sales.order_lines (
            line_id INTEGER NOT NULL,
            order_id BIGINT,
            note STRING
          )
          USING delta
          TBLPROPERTIES ('data.layer'='silver')
        `,
      },
      { defaultSchema: "sales", adoptExisting: true },
    );

    const definition = loadLakehouseTablesDefinition(
      input.itemDirectory,
      input.variables,
    );

    expect(definition.adoptExisting).toBe(true);
    expect(definition.tables.map((table) => table.logicalId)).toEqual([
      "orders",
      "orderLines",
    ]);
    expect(definition.tables[0]?.table).toEqual({
      schema: "sales",
      name: "orders",
      provider: "delta",
      managed: true,
      columns: [
        {
          name: "order_id",
          dataType: "bigint",
          nullable: false,
          comment: "Source order identifier",
        },
        {
          name: "order_date",
          dataType: "date",
          nullable: true,
        },
        {
          name: "amount",
          dataType: "decimal(18,2)",
          nullable: true,
        },
        {
          name: "description",
          dataType: "string",
          nullable: true,
        },
      ],
      partitionColumns: ["order_date"],
      comment: "Sales orders",
      properties: {
        "data.layer": "silver",
        note: "a semicolon; inside a string",
      },
    });
    expect(definition.tables[0]?.desiredHash).toMatch(/^[a-f0-9]{64}$/);
    expect(definition.desiredHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves manifest and SQL variables before validation", () => {
    const input = createDefinition(
      [{ logicalId: "orders", file: "tables/orders.sql" }],
      {
        "orders.sql": `
          CREATE TABLE IF NOT EXISTS \${var.SCHEMA}.orders (
            order_id BIGINT
          )
          USING DELTA
          TBLPROPERTIES ('environment' = '\${var.ENVIRONMENT}')
        `,
      },
      {
        defaultSchema: "${var.SCHEMA}",
        variables: {
          SCHEMA: "sales",
          ENVIRONMENT: "dev",
        },
      },
    );

    const definition = loadLakehouseTablesDefinition(
      input.itemDirectory,
      input.variables,
    );

    expect(definition.defaultSchema).toBe("sales");
    expect(definition.tables[0]?.table.properties).toEqual({
      environment: "dev",
    });
  });

  it("uses defaultSchema for unqualified table names", () => {
    expect(
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS orders (id INT) USING DELTA",
        { defaultSchema: "sales" },
      ),
    ).toMatchObject({
      schema: "sales",
      name: "orders",
    });

    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS orders (id INT) USING DELTA",
      ),
    ).toThrow("require defaultSchema");
  });

  it("produces semantic hashes independent of SQL formatting and aliases", () => {
    const first = parseLakehouseTableSql(`
      CREATE TABLE IF NOT EXISTS sales.orders (
        id INTEGER,
        amount DECIMAL(18, 2)
      ) USING DELTA
    `);
    const second = parseLakehouseTableSql(
      "create table if not exists sales.orders(id int,amount decimal(18,2)) using delta;",
    );

    expect(first).toEqual(second);
    expect(hashCanonicalLakehouseTable(first)).toBe(
      hashCanonicalLakehouseTable(second),
    );
  });

  it("produces deterministic definition hashes independent of manifest order", () => {
    const first = createDefinition(
      [
        { logicalId: "zeta", file: "tables/zeta.sql" },
        { logicalId: "alpha", file: "tables/alpha.sql" },
      ],
      {
        "alpha.sql":
          "CREATE TABLE IF NOT EXISTS sales.alpha (id INT) USING DELTA",
        "zeta.sql":
          "CREATE TABLE IF NOT EXISTS sales.zeta (id INT) USING DELTA",
      },
    );
    const second = createDefinition(
      [
        { logicalId: "alpha", file: "tables/alpha.sql" },
        { logicalId: "zeta", file: "tables/zeta.sql" },
      ],
      {
        "zeta.sql":
          "create table if not exists sales.zeta(id integer) using delta;",
        "alpha.sql":
          "create table if not exists sales.alpha(id integer) using delta;",
      },
    );

    const firstDefinition = loadLakehouseTablesDefinition(
      first.itemDirectory,
    );
    const secondDefinition = loadLakehouseTablesDefinition(
      second.itemDirectory,
    );

    expect(firstDefinition.tables.map((table) => table.logicalId)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(firstDefinition.desiredHash).toBe(secondDefinition.desiredHash);
  });

  it.each([
    [
      "multiple statements",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA; CREATE TABLE IF NOT EXISTS sales.other (id INT) USING DELTA",
      "Multiple SQL statements",
    ],
    [
      "destructive statement",
      "DROP TABLE sales.orders",
      "Expected keyword CREATE",
    ],
    [
      "create or replace",
      "CREATE OR REPLACE TABLE sales.orders (id INT) USING DELTA",
      "CREATE OR REPLACE",
    ],
    [
      "missing IF NOT EXISTS",
      "CREATE TABLE sales.orders (id INT) USING DELTA",
      "Expected keyword IF",
    ],
    [
      "non-Delta provider",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING PARQUET",
      "Only USING DELTA",
    ],
    [
      "external location",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA LOCATION 'Files/orders'",
      "LOCATION",
    ],
    [
      "options",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA OPTIONS ('path'='Files/orders')",
      "OPTIONS",
    ],
    [
      "CTAS",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA AS SELECT 1",
      "AS SELECT",
    ],
    [
      "protocol property",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA TBLPROPERTIES ('delta.minWriterVersion'='7')",
      "protocol behavior",
    ],
    [
      "reserved deployment property",
      "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA TBLPROPERTIES ('fabric.deploy.hash'='x')",
      "reserved",
    ],
  ])("rejects %s", (_name, sql, message) => {
    expect(() => parseLakehouseTableSql(sql)).toThrow(message);
  });

  it("rejects columns and table features outside the Phase 3A grammar", () => {
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id ARRAY<INT>) USING DELTA",
      ),
    ).toThrow("Unsupported character '<'");
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id INT DEFAULT 1) USING DELTA",
      ),
    ).toThrow();
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (Id INT) USING DELTA",
      ),
    ).toThrow("lowercase ASCII");
  });

  it("validates duplicate columns and partition columns", () => {
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id INT, id BIGINT) USING DELTA",
      ),
    ).toThrow("more than once");
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA PARTITIONED BY (missing)",
      ),
    ).toThrow("is not declared");
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA PARTITIONED BY (id, id)",
      ),
    ).toThrow("duplicated");
  });

  it("rejects duplicate and prototype-sensitive table property keys", () => {
    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA TBLPROPERTIES ('owner'='a', 'OWNER'='b')",
      ),
    ).toThrow("declared more than once");
    for (const key of [
      "__proto__",
      "prototype",
      "constructor",
      "ConStructor",
    ]) {
      expect(() =>
        parseLakehouseTableSql(
          `CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA TBLPROPERTIES ('${key}'='value')`,
        ),
      ).toThrow("unsafe");
    }
  });

  it("rejects inherited object property names as data types", () => {
    for (const dataType of [
      "constructor",
      "__proto__",
      "prototype",
    ]) {
      expect(() =>
        parseLakehouseTableSql(
          `CREATE TABLE IF NOT EXISTS sales.orders (id ${dataType}) USING DELTA`,
        ),
      ).toThrow("outside the Phase 3A scalar type allowlist");
    }
  });

  it.each([
    ["backslash", "unsafe\\value"],
    ["line feed", "unsafe\nvalue"],
    ["carriage return", "unsafe\rvalue"],
    ["NUL", "unsafe\u0000value"],
    ["C0 control", "unsafe\u0001value"],
    ["DEL", "unsafe\u007fvalue"],
    ["C1 control", "unsafe\u0085value"],
    ["Unicode line separator", "unsafe\u2028value"],
    ["Unicode paragraph separator", "unsafe\u2029value"],
  ])("rejects unsafe Spark SQL literal characters in %s", (_name, value) => {
    expect(() =>
      parseLakehouseTableSql(
        `CREATE TABLE IF NOT EXISTS sales.orders (id INT COMMENT '${value}') USING DELTA`,
      ),
    ).toThrow("unsafe character");
    expect(() =>
      parseLakehouseTableSql(
        `CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA COMMENT '${value}'`,
      ),
    ).toThrow("unsafe character");
    expect(() =>
      parseLakehouseTableSql(
        `CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA TBLPROPERTIES ('safe'='${value}')`,
      ),
    ).toThrow("unsafe character");
    expect(() =>
      parseLakehouseTableSql(
        `CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA TBLPROPERTIES ('${value}'='safe')`,
      ),
    ).toThrow("unsafe character");
  });

  it("rejects dependency cycles and unknown dependencies", () => {
    const cycle = createDefinition(
      [
        {
          logicalId: "orders",
          file: "tables/orders.sql",
          dependsOn: ["customers"],
        },
        {
          logicalId: "customers",
          file: "tables/customers.sql",
          dependsOn: ["orders"],
        },
      ],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
        "customers.sql":
          "CREATE TABLE IF NOT EXISTS sales.customers (id INT) USING DELTA",
      },
    );
    expect(() =>
      loadLakehouseTablesDefinition(cycle.itemDirectory),
    ).toThrow("dependency cycle");

    const unknown = createDefinition(
      [
        {
          logicalId: "orders",
          file: "tables/orders.sql",
          dependsOn: ["missing"],
        },
      ],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
    );
    expect(() =>
      loadLakehouseTablesDefinition(unknown.itemDirectory),
    ).toThrow("unknown table 'missing'");
  });

  it("rejects duplicate physical table identifiers", () => {
    const input = createDefinition(
      [
        { logicalId: "first", file: "tables/first.sql" },
        { logicalId: "second", file: "tables/second.sql" },
      ],
      {
        "first.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
        "second.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
    );

    expect(() =>
      loadLakehouseTablesDefinition(input.itemDirectory),
    ).toThrow("both declare 'sales.orders'");
  });

  it("rejects undeclared SQL files and unsafe manifest fields", () => {
    const undeclared = createDefinition(
      [{ logicalId: "orders", file: "tables/orders.sql" }],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
        "forgotten.sql":
          "CREATE TABLE IF NOT EXISTS sales.forgotten (id INT) USING DELTA",
      },
    );
    expect(() =>
      loadLakehouseTablesDefinition(undeclared.itemDirectory),
    ).toThrow("is not declared");

    const unsafePath = createDefinition(
      [{ logicalId: "orders", file: "../orders.sql" }],
      {},
    );
    expect(() =>
      loadLakehouseTablesDefinition(unsafePath.itemDirectory),
    ).toThrow("must match 'tables/*.sql'");

    const extraProperty = createDefinition(
      [{ logicalId: "orders", file: "tables/orders.sql" }],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS sales.orders (id INT) USING DELTA",
      },
      { extraManifest: { executionMode: "unsafe" } },
    );
    expect(() =>
      loadLakehouseTablesDefinition(extraProperty.itemDirectory),
    ).toThrow("unsupported property");
  });

  it("rejects unresolved or missing deployment variables", () => {
    const missing = createDefinition(
      [{ logicalId: "orders", file: "tables/orders.sql" }],
      {
        "orders.sql":
          "CREATE TABLE IF NOT EXISTS ${var.SCHEMA}.orders (id INT) USING DELTA",
      },
    );
    expect(() =>
      loadLakehouseTablesDefinition(missing.itemDirectory),
    ).toThrow("Required deployment variable SCHEMA");

    expect(() =>
      parseLakehouseTableSql(
        "CREATE TABLE IF NOT EXISTS sales.orders (id INT COMMENT '${secret.VALUE}') USING DELTA",
      ),
    ).toThrow("unresolved template syntax");
  });
});
