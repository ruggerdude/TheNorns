import { describe, expect, it } from "vitest";
import { type ProjectRepository, projectRepository } from "../src/projects/repository.js";
import { ProjectStore } from "../src/projects/store.js";

describe("ProjectRepository compatibility port", () => {
  it("keeps ProjectStore behind an operation port without exposing GraphSession or snapshots", async () => {
    const store = new ProjectStore();
    const repository: ProjectRepository = projectRepository(store);

    const project = await repository.create({
      name: "Compatibility",
      description: "Legacy storage behind the Phase 1 repository port",
      pmProvider: "openai",
    });

    expect(repository).not.toBe(store);
    expect((await repository.summary(project.id)).name).toBe("Compatibility");
    expect(await repository.list()).toHaveLength(1);
    expect("session" in repository).toBe(false);
    expect("snapshot" in repository).toBe(false);
  });
});
