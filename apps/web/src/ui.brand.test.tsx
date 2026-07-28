import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BraidMark } from "./BraidMark";
import { Brand, BrandMark } from "./ui";

describe("BraidMark", () => {
  it("renders a 3-strand braid with over/under segments in all three colors", () => {
    const { container } = render(
      <BraidMark width={64} height={26} lead={14} period={34} strokeWidth={4.5} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "0 0 64 26");
    expect(svg).toHaveAttribute("width", "64");
    expect(svg).toHaveAttribute("height", "26");

    const paths = [...container.querySelectorAll("path")];
    // Crossings split the strands: more path segments than the 3 raw strands.
    expect(paths.length).toBeGreaterThan(3);
    const strokes = new Set(paths.map((p) => p.getAttribute("stroke")));
    expect(strokes).toEqual(
      new Set(["var(--brand-ink)", "var(--gold)", "var(--ink-muted)"]),
    );
    for (const p of paths) {
      expect(p.getAttribute("fill")).toBe("none");
      expect(p.getAttribute("stroke-width")).toBe("4.5");
      expect(p.getAttribute("stroke-linecap")).toBe("round");
    }
  });

  it("is a pure function of its props (identical markup across renders)", () => {
    const a = render(<BraidMark width={300} height={34} lead={96} period={78} strokeWidth={6} />);
    const b = render(<BraidMark width={300} height={34} lead={96} period={78} strokeWidth={6} />);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
  });

  it("accepts custom strand colors", () => {
    const { container } = render(<BraidMark strand1="#111" strand2="#222" strand3="#333" />);
    const strokes = new Set(
      [...container.querySelectorAll("path")].map((p) => p.getAttribute("stroke")),
    );
    expect(strokes).toEqual(new Set(["#111", "#222", "#333"]));
  });
});

describe("Brand lockup", () => {
  it("topbar variant renders the 64×26 braid beside the uncial wordmark", () => {
    const { container, getByText } = render(<Brand />);
    const lockup = container.querySelector(".brand");
    expect(lockup).not.toBeNull();
    expect(lockup?.querySelector("svg")).toHaveAttribute("viewBox", "0 0 64 26");
    const word = getByText("The Norns");
    expect(word).toHaveClass("brand-word");
    // Braid first, wordmark after (side-by-side topbar order).
    expect(lockup?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("hero variant stacks the wordmark above the 300×34 braid", () => {
    const { container } = render(<Brand variant="hero" />);
    const lockup = container.querySelector(".brand.brand-hero");
    expect(lockup).not.toBeNull();
    expect(lockup?.firstElementChild).toHaveClass("brand-word");
    expect(lockup?.querySelector("svg")).toHaveAttribute("viewBox", "0 0 300 34");
  });

  it("BrandMark keeps its size API by scaling the topbar braid recipe", () => {
    const { container } = render(<BrandMark size={52} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("height", "52");
    expect(svg).toHaveAttribute("width", "128");
  });
});
