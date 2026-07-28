/**
 * DESIGN R2 — the braided-threads mark: a 3-strand braid with true
 * over/under crossings (the Norns weaving fate). Ported from the owner's
 * design source at artifacts/redesign/braid-logo-generator.html: each strand
 * is a straight lead-in followed by a sinusoid; strand paths are split at
 * every crossing and the segments alternate depth, so under-segments render
 * first and over-segments after. Pure function of props — no state, no
 * effects.
 */

export interface BraidMarkProps {
  /** Total SVG width in px. */
  width?: number;
  /** Total SVG height in px. */
  height?: number;
  /** Length of the straight lead-in before the braid starts. */
  lead?: number;
  /** Wavelength of the braid sinusoid. */
  period?: number;
  /** Stroke width of each strand. */
  strokeWidth?: number;
  /** Sinusoid amplitude. Defaults to filling the height minus the stroke. */
  amplitude?: number;
  /** First strand color (indigo). */
  strand1?: string;
  /** Second strand color (gold). */
  strand2?: string;
  /** Third strand color (silver). */
  strand3?: string;
  className?: string;
}

interface Segment {
  strand: number;
  from: number;
  to: number;
  over: boolean;
}

const SAMPLES = 240;
const PHASES: [number, number, number] = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

/** Safe indexed access (noUncheckedIndexedAccess): every index we use is in range. */
function at(arr: number[], i: number): number {
  return arr[i] ?? 0;
}

function computeSegments(
  width: number,
  height: number,
  lead: number,
  period: number,
  amplitude: number,
): { xs: number[]; ys: [number[], number[], number[]]; segments: Segment[] } {
  const mid = height / 2;
  const xs: number[] = [];
  const ys: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = 4 + ((width - 8) * i) / SAMPLES;
    xs.push(x);
    for (let k = 0; k < 3; k++) {
      if (x <= lead) {
        // Straight lead-in at the strand's start height (sin at t=0 ordering).
        ys[k]?.push(mid + amplitude * Math.sin(at(PHASES, k)));
      } else {
        const t = ((x - lead) / period) * 2 * Math.PI;
        ys[k]?.push(mid + amplitude * Math.sin(t + at(PHASES, k)));
      }
    }
  }
  // Crossing x-indices between each strand pair become segment boundaries.
  const bounds: [number[], number[], number[]] = [[], [], []];
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      for (let i = 1; i <= SAMPLES; i++) {
        const d0 = at(ys[a] ?? [], i - 1) - at(ys[b] ?? [], i - 1);
        const d1 = at(ys[a] ?? [], i) - at(ys[b] ?? [], i);
        if (d0 === 0) continue;
        if (d0 < 0 !== d1 < 0) {
          bounds[a]?.push(i);
          bounds[b]?.push(i);
        }
      }
    }
  }
  // Build segments per strand; depth alternates per segment index.
  const segments: Segment[] = [];
  for (let k = 0; k < 3; k++) {
    const bs = [0, ...(bounds[k] ?? []).sort((x, y) => x - y), SAMPLES];
    for (let s = 0; s < bs.length - 1; s++) {
      segments.push({ strand: k, from: at(bs, s), to: at(bs, s + 1), over: s % 2 === 1 });
    }
  }
  return { xs, ys, segments };
}

function segmentPath(xs: number[], ys: [number[], number[], number[]], seg: Segment): string {
  const strand = ys[seg.strand] ?? [];
  let d = `M ${at(xs, seg.from).toFixed(1)} ${at(strand, seg.from).toFixed(1)}`;
  for (let i = seg.from + 1; i <= seg.to; i++) {
    d += ` L ${at(xs, i).toFixed(1)} ${at(strand, i).toFixed(1)}`;
  }
  return d;
}

export function BraidMark({
  width = 64,
  height = 26,
  lead = 14,
  period = 34,
  strokeWidth = 4.5,
  amplitude,
  strand1 = "var(--brand-ink)",
  strand2 = "var(--gold)",
  strand3 = "var(--ink-muted)",
  className,
}: BraidMarkProps) {
  const a = amplitude ?? height / 2 - strokeWidth / 2 - 1;
  const { xs, ys, segments } = computeSegments(width, height, lead, period, a);
  const colors: [string, string, string] = [strand1, strand2, strand3];
  // Unders first, overs after, so overs visually cross on top.
  const ordered = [...segments.filter((s) => !s.over), ...segments.filter((s) => s.over)];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-hidden="true"
    >
      {ordered.map((seg) => (
        <path
          key={`${seg.strand}-${seg.from}-${seg.to}-${seg.over ? "o" : "u"}`}
          d={segmentPath(xs, ys, seg)}
          fill="none"
          stroke={colors[seg.strand] ?? strand1}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
