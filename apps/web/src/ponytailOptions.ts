import type { PonytailModeT, ProjectPonytailModeT } from "@norns/contracts";

export const PONYTAIL_OPTIONS: ReadonlyArray<{
  value: PonytailModeT;
  label: string;
  help: string;
}> = [
  { value: "off", label: "Off", help: "Use the agent's normal implementation style." },
  { value: "lite", label: "Lite", help: "Build the full request and point out simpler options." },
  {
    value: "full",
    label: "Full",
    help: "Prefer reuse, native features, and the smallest correct diff.",
  },
  { value: "ultra", label: "Ultra", help: "Aggressively challenge non-mandatory complexity." },
];

export const PROJECT_PONYTAIL_OPTIONS: ReadonlyArray<{
  value: ProjectPonytailModeT;
  label: string;
}> = [
  { value: "inherit", label: "Use global default" },
  ...PONYTAIL_OPTIONS.map(({ value, label }) => ({ value, label })),
];

export function ponytailModeLabel(mode: PonytailModeT): string {
  return PONYTAIL_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}
