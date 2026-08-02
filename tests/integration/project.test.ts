import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectFromWorkingDirectory } from "@/lib/myagents/project";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("projectFromWorkingDirectory", () => {
  it("falls back to a path project outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-path-project-"));
    roots.push(root);

    expect(projectFromWorkingDirectory(root)).toEqual({
      id: `path:${root}`,
      name: basename(root),
      path: root,
    });
  });

  it("groups a repository and its linked worktree under one project", async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-git-project-"));
    roots.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    await mkdir(repository);
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.email=tests@example.com",
        "-c",
        "user.name=Tests",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", repository, "worktree", "add", "-b", "test-worktree", worktree], {
      stdio: "ignore",
    });

    const primary = projectFromWorkingDirectory(repository);
    const linked = projectFromWorkingDirectory(worktree);
    expect(linked.id).toBe(primary.id);
    expect(linked.path).toBe(repository);
    expect(linked.name).toBe("repository");
  });
});
