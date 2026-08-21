import { z } from "zod";

export const PonytailMode = z.enum(["off", "lite", "full", "ultra"]);
export type PonytailModeT = z.infer<typeof PonytailMode>;

export const ProjectPonytailMode = z.enum(["inherit", ...PonytailMode.options]);
export type ProjectPonytailModeT = z.infer<typeof ProjectPonytailMode>;

export const DEFAULT_PONYTAIL_MODE: PonytailModeT = "full";
