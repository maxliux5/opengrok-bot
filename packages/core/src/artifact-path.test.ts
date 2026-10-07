import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactDir } from "./config.js";
import { resolveArtifactPath, storedArtifactPath } from "./artifact-path.js";

describe("artifact paths", () => {
  it("stores relative paths and resolves them under the configured artifact directory", () => {
    const path = join(artifactDir, "run-id", "report.md");
    expect(storedArtifactPath(path)).toBe(join("run-id", "report.md"));
    expect(resolveArtifactPath(join("run-id", "report.md"))).toBe(path);
    expect(resolveArtifactPath(path)).toBe(path);
  });

  it("rejects traversal and foreign absolute paths", () => {
    expect(() => resolveArtifactPath("../master.key")).toThrow();
    expect(() => resolveArtifactPath(resolve(artifactDir, "../master.key"))).toThrow();
    expect(() => storedArtifactPath(resolve(artifactDir, "../master.key"))).toThrow();
  });
});
