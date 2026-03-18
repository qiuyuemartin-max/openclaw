import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

/** Resolve path for host edit: expand ~ and resolve relative paths against root. */
function resolveHostEditPath(root: string, pathParam: string): string {
  const expanded =
    pathParam.startsWith("~/") || pathParam === "~"
      ? pathParam.replace(/^~/, os.homedir())
      : pathParam;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

/**
 * When the upstream edit tool throws after having already written (e.g. generateDiffString fails),
 * the file may be correctly updated but the tool reports failure. This wrapper catches errors and
 * if the target file on disk contains the intended newText, returns success so we don't surface
 * a false "edit failed" to the user (fixes #32333, same pattern as #30773 for write).
 *
 * Also handles the case where the upstream edit tool returns isError=true without throwing,
 * but the file has actually been modified correctly (fixes #49363).
 */
export function wrapHostEditToolWithPostWriteRecovery(
  base: AnyAgentTool,
  root: string,
): AnyAgentTool {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      // Extract params once so both the isError check and the catch block can use them.
      const record =
        params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
      const pathParam = record && typeof record.path === "string" ? record.path : undefined;
      const newText =
        record && typeof record.newText === "string"
          ? record.newText
          : record && typeof record.new_string === "string"
            ? record.new_string
            : undefined;
      const oldText =
        record && typeof record.oldText === "string"
          ? record.oldText
          : record && typeof record.old_string === "string"
            ? record.old_string
            : undefined;

      /**
       * Attempt post-write recovery: if the file on disk contains newText and no longer
       * contains oldText, the edit succeeded and we return a synthetic success result.
       * Returns undefined when recovery is not applicable.
       */
      async function tryRecover(): Promise<AgentToolResult<unknown> | undefined> {
        if (!pathParam || !newText) return undefined;
        try {
          const absolutePath = resolveHostEditPath(root, pathParam);
          const content = await fs.readFile(absolutePath, "utf-8");
          // Only recover when the replacement likely occurred: newText is present and oldText
          // is no longer present. This avoids false success when upstream threw before writing
          // (e.g. oldText not found) but the file already contained newText (review feedback).
          const hasNew = content.includes(newText);
          const stillHasOld =
            oldText !== undefined && oldText.length > 0 && content.includes(oldText);
          if (hasNew && !stillHasOld) {
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully replaced text in ${pathParam}.`,
                },
              ],
              details: { diff: "", firstChangedLine: undefined },
            } as AgentToolResult<unknown>;
          }
        } catch {
          // File read failed or path invalid; recovery not possible.
        }
        return undefined;
      }

      try {
        const result = await base.execute(toolCallId, params, signal, onUpdate);

        // NEW (#49363): Handle false-positive failures — base tool returned isError=true
        // without throwing, but the file was actually modified correctly.
        if (
          result != null &&
          typeof result === "object" &&
          (result as Record<string, unknown>).isError === true
        ) {
          const recovered = await tryRecover();
          if (recovered !== undefined) {
            return recovered;
          }
        }

        return result;
      } catch (err) {
        const recovered = await tryRecover();
        if (recovered !== undefined) {
          return recovered;
        }
        throw err;
      }
    },
  };
}
