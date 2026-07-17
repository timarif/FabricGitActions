import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  hashNotebookDefinition,
  loadNotebookDefinition,
} from "../src/fabric/notebook-definition";

function notebookDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-notebook-"));
  const itemDirectory = path.join(root, "notebook");
  mkdirSync(path.join(itemDirectory, "definition"), { recursive: true });
  return itemDirectory;
}

describe("Notebook definitions", () => {
  it("maps a source file to the Fabric Git definition contract", () => {
    const itemDirectory = notebookDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "hello.py"),
      "print('hello')\n",
      "utf8",
    );

    const definition = loadNotebookDefinition(itemDirectory);

    expect(definition.format).toBe("fabricGitSource");
    expect(definition.parts).toHaveLength(1);
    expect(definition.parts[0]?.path).toBe("notebook-content.py");
    expect(
      Buffer.from(
        definition.parts[0]?.payload ?? "",
        "base64",
      ).toString("utf8"),
    ).toBe("print('hello')\n");
  });

  it("loads ipynb content and optional platform metadata", () => {
    const itemDirectory = notebookDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "source.ipynb"),
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        cells: [],
        metadata: {},
      }),
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition", ".platform"),
      JSON.stringify({
        metadata: {
          type: "Notebook",
          displayName: "Hello",
          description: "",
        },
      }),
      "utf8",
    );

    const definition = loadNotebookDefinition(itemDirectory);

    expect(definition.format).toBe("ipynb");
    expect(definition.parts.map((part) => part.path)).toEqual([
      ".platform",
      "notebook-content.ipynb",
    ]);
  });

  it("hashes source line endings and JSON formatting semantically", () => {
    const first: FabricDefinition = {
      format: "fabricGitSource",
      parts: [
        {
          path: "notebook-content.py",
          payload: Buffer.from("print('hello')\r\n").toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from('{"metadata":{"type":"Notebook","x":1}}').toString(
            "base64",
          ),
          payloadType: "InlineBase64",
        },
      ],
    };
    const second: FabricDefinition = {
      parts: [
        {
          path: "renamed.py",
          payload: Buffer.from("print('hello')\n").toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from(
            '{\n  "metadata": { "x": 1, "type": "Notebook" }\n}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    expect(hashNotebookDefinition(first, true)).toBe(
      hashNotebookDefinition(second, true),
    );
  });

  it("rejects multiple notebook content files", () => {
    const itemDirectory = notebookDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "first.py"),
      "print('first')\n",
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition", "second.sql"),
      "SELECT 1\n",
      "utf8",
    );

    expect(() => loadNotebookDefinition(itemDirectory)).toThrow(
      "exactly one",
    );
  });

  it("rejects definition files that are not deployed", () => {
    const itemDirectory = notebookDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "notebook.py"),
      "print('hello')\n",
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition", "notes.txt"),
      "not deployed",
      "utf8",
    );

    expect(() => loadNotebookDefinition(itemDirectory)).toThrow(
      "Unsupported Notebook definition path",
    );
  });
});
