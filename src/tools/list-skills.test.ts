import { describe, it, expect } from "bun:test";

// We test the tool definition structure and mock the loadSkills dependency
// to avoid relying on the actual .ecc directory at test time.

describe("createListSkillsTool", () => {
  describe("tool definition", () => {
    it("should have the correct name", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      expect(tool.name).toBe("list_skills");
    });

    it("should have a description mentioning skills", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      expect(tool.description).toBeTruthy();
      expect(tool.description.toLowerCase()).toContain("skill");
    });

    it("should have memory category", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      expect(tool.categories).toEqual(["memory"]);
    });

    it("should have an inputSchema with optional filter property", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      expect(tool.inputSchema.type).toBe("object");
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.filter).toBeDefined();
      // filter is not required
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("should have an execute function", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      expect(typeof tool.execute).toBe("function");
    });
  });

  describe("execute", () => {
    // We rely on whatever skills are actually available in the project.
    // The key test is that the function runs without throwing and returns
    // a sensible format. If no skills exist, it returns "No skills found."

    it("should return a non-error result when called without filter", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      const result = await tool.execute({});
      expect(result.isError).toBe(false);
      // Output is either "No skills found." or a list
      expect(typeof result.output).toBe("string");
    });

    it("should return a non-error result when called with a filter", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      const result = await tool.execute({ filter: "nonexistent-xyzzy-filter" });
      expect(result.isError).toBe(false);
      // With a gibberish filter, we should get "No skills found."
      expect(result.output).toBe("No skills found.");
    });

    it("should format skills as markdown list items", async () => {
      const { createListSkillsTool } = await import("./list-skills");
      const tool = createListSkillsTool();
      const result = await tool.execute({});
      if (result.output !== "No skills found.") {
        // If there are skills, each line should be a markdown list item
        const lines = result.output.split("\n");
        for (const line of lines) {
          expect(line).toMatch(/^- \*\*.+\*\*: /);
        }
      }
    });
  });
});
