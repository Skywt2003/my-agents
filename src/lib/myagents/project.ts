import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

import type { SessionProject } from "@/lib/myagents/types";

const projects = new Map<string, SessionProject>();

export function projectFromWorkingDirectory(cwd: string): SessionProject {
  const cached = projects.get(cwd);
  if (cached) return cached;

  let project: SessionProject;
  try {
    const [gitCommonDirectory, worktree] = execFileSync(
      "git",
      [
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n");
    const repository = dirname(gitCommonDirectory);
    project = {
      id: `git:${gitCommonDirectory}`,
      name: basename(repository),
      path: repository || worktree,
    };
  } catch {
    project = {
      id: `path:${cwd}`,
      name: basename(cwd) || cwd,
      path: cwd,
    };
  }

  projects.set(cwd, project);
  return project;
}
