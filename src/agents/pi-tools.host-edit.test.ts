/**
 * Tests for wrapHostEditToolWithPostWriteRecovery:
 * - Covers the throw-based recovery (originally fixed in #32333)
 * - Covers the isError=true return-based false-positive recovery (fixes #49363)
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { wrapHostEditToolWithPostWriteRecovery } from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseTool(
  behavior:
    | { mode: "throw"; error: Error }
    | { mode: "return"; result: AgentToolResult<unknown> }
    | { mode: "success"; result: AgentToolResult<unknown> },
): AnyAgentTool {
  return {
    name: "edit",
    description: "edit tool stub",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    execute: async () => {
      if (behavior.mode === "throw") {
        throw behavior.error;
      }
      return behavior.result as AgentToolResult<unknown>;
    },
  };
}

function textOf(result: AgentToolResult<unknown>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        b != null && typeof b === "object" && (b as { type?: unknown }).type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir = "";

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

async function makeTmp(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-edit-test-"));
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Suite: throw-based recovery (pre-existing behaviour, regression guard)
// ---------------------------------------------------------------------------

describe("wrapHostEditToolWithPostWriteRecovery — throw-based recovery (#32333)", () => {
  it("returns success when base tool throws but file has newText and no longer has oldText", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "file.md");
    const oldText = "# Old Header";
    const newText = "# New Header";
    // Simulate: file was written before the throw
    await fs.writeFile(filePath, `# New Header\n\nsome content`, "utf-8");

    const base = makeBaseTool({
      mode: "throw",
      error: new Error("generateDiffString failed"),
    });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute("c1", { path: filePath, oldText, newText }, undefined);

    expect(textOf(result)).toContain("Successfully replaced text");
    expect((result as Record<string, unknown>).isError).not.toBe(true);
  });

  it("rethrows when file does not contain newText (pre-write failure)", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "file.md");
    await fs.writeFile(filePath, "unchanged", "utf-8");

    const base = makeBaseTool({ mode: "throw", error: new Error("upstream error") });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    await expect(
      wrapped.execute("c1", { path: filePath, oldText: "x", newText: "never-written" }, undefined),
    ).rejects.toThrow("upstream error");
  });

  it("rethrows when file still contains oldText (write did not complete)", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "file.md");
    const oldText = "replace me";
    const newText = "new content";
    // Both old and new are present — ambiguous; we conservatively rethrow
    await fs.writeFile(filePath, `before ${oldText} after ${newText}`, "utf-8");

    const base = makeBaseTool({ mode: "throw", error: new Error("write incomplete") });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    await expect(
      wrapped.execute("c1", { path: filePath, oldText, newText }, undefined),
    ).rejects.toThrow("write incomplete");
  });

  it("rethrows when params lack path or newText", async () => {
    const dir = await makeTmp();

    const base = makeBaseTool({ mode: "throw", error: new Error("no params") });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    await expect(
      wrapped.execute("c1", { oldText: "x" }, undefined),
    ).rejects.toThrow("no params");
  });
});

// ---------------------------------------------------------------------------
// Suite: isError=true return-based recovery (new behaviour, fixes #49363)
// ---------------------------------------------------------------------------

describe("wrapHostEditToolWithPostWriteRecovery — isError return recovery (#49363)", () => {
  it("returns success when base tool returns isError=true but file was actually modified", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "target.md");
    const oldText = "# Old Title";
    const newText = "# New Title";
    // File already has newText (edit succeeded), but base tool incorrectly returns isError
    await fs.writeFile(filePath, `# New Title\n\ncontent`, "utf-8");

    const base = makeBaseTool({
      mode: "return",
      result: {
        isError: true,
        content: [{ type: "text", text: "Edit failed: generateDiffString error" }],
      } as unknown as AgentToolResult<unknown>,
    });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute("c1", { path: filePath, oldText, newText }, undefined);

    // Should recover and return success
    expect(textOf(result)).toContain("Successfully replaced text");
    expect((result as Record<string, unknown>).isError).not.toBe(true);
  });

  it("uses new_string / old_string aliases for isError recovery", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "alias.md");
    const old_string = "old value";
    const new_string = "new value";
    await fs.writeFile(filePath, `new value\n`, "utf-8");

    const base = makeBaseTool({
      mode: "return",
      result: {
        isError: true,
        content: [{ type: "text", text: "failed" }],
      } as unknown as AgentToolResult<unknown>,
    });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute(
      "c1",
      { path: filePath, old_string, new_string },
      undefined,
    );

    expect(textOf(result)).toContain("Successfully replaced text");
    expect((result as Record<string, unknown>).isError).not.toBe(true);
  });

  it("passes through isError=true when file was NOT modified", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "untouched.md");
    await fs.writeFile(filePath, "completely different content", "utf-8");

    const errorResult = {
      isError: true,
      content: [{ type: "text", text: "Edit failed: oldText not found" }],
    } as unknown as AgentToolResult<unknown>;

    const base = makeBaseTool({ mode: "return", result: errorResult });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute(
      "c1",
      { path: filePath, oldText: "missing", newText: "never-written" },
      undefined,
    );

    // isError=true should be passed through as-is; no false recovery
    expect((result as Record<string, unknown>).isError).toBe(true);
    expect(textOf(result)).toContain("oldText not found");
  });

  it("passes through isError=true when file still contains oldText (ambiguous state)", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "ambiguous.md");
    const oldText = "original";
    const newText = "replacement";
    // Both old and new present — conservative: don't recover
    await fs.writeFile(filePath, `original and replacement`, "utf-8");

    const errorResult = {
      isError: true,
      content: [{ type: "text", text: "ambiguous failure" }],
    } as unknown as AgentToolResult<unknown>;

    const base = makeBaseTool({ mode: "return", result: errorResult });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute(
      "c1",
      { path: filePath, oldText, newText },
      undefined,
    );

    expect((result as Record<string, unknown>).isError).toBe(true);
  });

  it("passes through successful results unchanged", async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, "success.md");
    await fs.writeFile(filePath, "content", "utf-8");

    const successResult: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "Edit successful" }],
      details: { diff: "- old\n+ new", firstChangedLine: 1 },
    };

    const base = makeBaseTool({ mode: "success", result: successResult });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute(
      "c1",
      { path: filePath, oldText: "old", newText: "new" },
      undefined,
    );

    expect(result).toBe(successResult); // exact same object reference
    expect(textOf(result)).toBe("Edit successful");
  });

  it("passes through isError=true when params missing path", async () => {
    const dir = await makeTmp();

    const errorResult = {
      isError: true,
      content: [{ type: "text", text: "no path provided" }],
    } as unknown as AgentToolResult<unknown>;

    const base = makeBaseTool({ mode: "return", result: errorResult });
    const wrapped = wrapHostEditToolWithPostWriteRecovery(base, dir);

    const result = await wrapped.execute("c1", { newText: "something" }, undefined);

    // Can't recover without path; pass isError through
    expect((result as Record<string, unknown>).isError).toBe(true);
  });
});
