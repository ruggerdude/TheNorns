// Project Memory (PRD R4 §Project Memory): human-approved standing directives
// the engine injects verbatim into EVERY agent context. approved_by_human is
// a literal `true` — an unapproved entry cannot even be represented.
import { z } from "zod";

const nonEmpty = z.string().min(1);

export const ProjectMemoryEntry = z.object({
  id: nonEmpty,
  directive: z.string().min(1).max(500),
  version: z.number().int().positive(),
  active: z.boolean().default(true),
  created_by: z.enum(["human", "pm"]),
  approved_by_human: z.literal(true),
  created_at: z.string().datetime(),
});
export type ProjectMemoryEntryT = z.infer<typeof ProjectMemoryEntry>;

/** Deterministic render of the memory block injected into agent contexts. */
export function renderMemoryBlock(entries: readonly ProjectMemoryEntryT[]): string {
  const active = entries.filter((entry) => entry.active);
  if (active.length === 0) return "";
  const lines = active.map((entry) => `- ${entry.directive}`);
  return `<project_memory>\n${lines.join("\n")}\n</project_memory>`;
}
