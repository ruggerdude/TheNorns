import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPublicProbeAddress } from "../src/phase6/healthProbe.js";
import {
  MOCKUP_DESKTOP_VIEWPORT,
  MOCKUP_MOBILE_VIEWPORT,
  renderDeterministicMockup,
} from "../src/phase6/renderer.js";

const layout = {
  schema_version: 1 as const,
  title: "Project status",
  summary: "A concise responsive project dashboard.",
  target: "responsive" as const,
  sections: [
    {
      heading: "Needs attention",
      body: "Show durable decision points without inferring deployment state.",
      emphasis: "warning" as const,
    },
  ],
  interaction_notes: ["Desktop and mobile are reviewed together."],
  source_artifact_ids: ["artifact-source"],
};

describe("Phase 6 deterministic renderer and probe address policy", () => {
  it("renders byte-identical fixed viewport PNGs from the same strict layout", () => {
    const first = renderDeterministicMockup(layout);
    const second = renderDeterministicMockup(layout);
    expect(createHash("sha256").update(first.desktop).digest("hex")).toBe(
      createHash("sha256").update(second.desktop).digest("hex"),
    );
    expect(createHash("sha256").update(first.mobile).digest("hex")).toBe(
      createHash("sha256").update(second.mobile).digest("hex"),
    );
    expect(first.desktop.readUInt32BE(16)).toBe(MOCKUP_DESKTOP_VIEWPORT.width);
    expect(first.desktop.readUInt32BE(20)).toBe(MOCKUP_DESKTOP_VIEWPORT.height);
    expect(first.mobile.readUInt32BE(16)).toBe(MOCKUP_MOBILE_VIEWPORT.width);
    expect(first.mobile.readUInt32BE(20)).toBe(MOCKUP_MOBILE_VIEWPORT.height);
    expect(first.profile.network).toBe("disabled");
    expect(first.profile.scripts).toBe("disabled");
  });

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])("rejects non-public health-probe address %s", (address) => {
    expect(isPublicProbeAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts globally routable health-probe address %s",
    (address) => {
      expect(isPublicProbeAddress(address)).toBe(true);
    },
  );
});
