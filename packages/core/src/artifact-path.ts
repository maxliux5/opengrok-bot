import { isAbsolute, relative, resolve, sep } from "node:path";
import { artifactDir } from "./config.js";
import { DomainError } from "./errors.js";

function withinArtifactDir(path: string): string {
  const absolute = resolve(path);
  const stored = relative(artifactDir, absolute);
  if (!stored || stored === ".." || stored.startsWith(`..${sep}`) || isAbsolute(stored)) {
    throw new DomainError("成果文件路径不在成果目录内", 409, "artifact_path_invalid");
  }
  return stored;
}

export function storedArtifactPath(path: string): string {
  return withinArtifactDir(path);
}

export function resolveArtifactPath(storedPath: string): string {
  const path = isAbsolute(storedPath) ? storedPath : resolve(artifactDir, storedPath);
  withinArtifactDir(path);
  return resolve(path);
}
