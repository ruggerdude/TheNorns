import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("relational runner event watermark", () => {
  let pg: PGlite;
  let processor: Phase4EventProcessor;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN;");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    processor = new Phase4EventProcessor(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => pg.close());

  it("returns the highest contiguous durable sequence and stops before a gap", async () => {
    await pg.exec(`
      INSERT INTO runner_events (
        id,runner_id,runner_generation,sequence,event_type,payload,
        correlation_id,occurred_at
      ) VALUES
        ('event-1','runner-1',3,1,'heartbeat','{"kind":"heartbeat"}',
         'correlation-1','2026-08-16T00:00:01Z'),
        ('event-2','runner-1',3,2,'heartbeat','{"kind":"heartbeat"}',
         'correlation-2','2026-08-16T00:00:02Z'),
        ('event-4','runner-1',3,4,'heartbeat','{"kind":"heartbeat"}',
         'correlation-4','2026-08-16T00:00:04Z'),
        ('other-generation','runner-1',4,1,'heartbeat','{"kind":"heartbeat"}',
         'correlation-other','2026-08-16T00:00:05Z')
    `);

    await expect(processor.watermark("runner-1", 3)).resolves.toBe(2);
    await expect(processor.watermark("runner-1", 4)).resolves.toBe(1);
    await expect(processor.watermark("runner-missing", 1)).resolves.toBe(0);
  });
});
