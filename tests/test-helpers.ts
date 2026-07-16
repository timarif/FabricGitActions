import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function createFixture(
  root: string,
  manifest: string,
  itemDirectories: string[] = ["items/lakehouses/bronze"],
): string {
  for (const directory of itemDirectories) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(
      path.join(root, directory, "item.yaml"),
      `displayName: ${path.basename(directory)}\n`,
      "utf8",
    );
  }
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(manifestPath, manifest, "utf8");
  return manifestPath;
}
