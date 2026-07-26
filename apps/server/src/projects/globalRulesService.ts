import type { V2TransactionRunner } from "../persistence/v2/database.js";

export const GLOBAL_RULES_FILENAME = "NORN.md";

export interface GlobalRulesDto {
  filename: typeof GLOBAL_RULES_FILENAME;
  content: string;
  version: number;
  updated_at: string | null;
}

interface GlobalRulesRow {
  content: string;
  version: number;
  updated_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** One administrator-owned rules file applied to task briefings in every project. */
export class GlobalRulesService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(): Promise<GlobalRulesDto> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<GlobalRulesRow>(
        `SELECT content, version, updated_at
           FROM global_rule_settings
          WHERE id = 'global'`,
      );
      const row = result.rows[0];
      return {
        filename: GLOBAL_RULES_FILENAME,
        content: row?.content ?? "",
        version: row?.version ?? 0,
        updated_at: row ? iso(row.updated_at) : null,
      };
    });
  }

  async save(actorId: string, content: string): Promise<GlobalRulesDto> {
    const normalized = content.replaceAll("\r\n", "\n").trim();
    return this.transactions.transaction(async (tx) => {
      const savedAt = this.now().toISOString();
      const result = await tx.query<GlobalRulesRow>(
        `INSERT INTO global_rule_settings (
           id, filename, content, version, updated_by, updated_at
         ) VALUES ('global', $1, $2, 1, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET content = EXCLUDED.content,
               version = global_rule_settings.version + 1,
               updated_by = EXCLUDED.updated_by,
               updated_at = EXCLUDED.updated_at
         RETURNING content, version, updated_at`,
        [GLOBAL_RULES_FILENAME, normalized, actorId, savedAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error("global rules update returned no row");
      return {
        filename: GLOBAL_RULES_FILENAME,
        content: row.content,
        version: row.version,
        updated_at: iso(row.updated_at),
      };
    });
  }
}
