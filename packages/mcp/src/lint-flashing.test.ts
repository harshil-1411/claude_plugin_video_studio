import { describe, expect, it } from "vitest";
import { type LintFinding, checkFlashing } from "./lint.js";

describe("lint flashing (QA flash measurement on the render)", () => {
  it("errors above 3 flashes per second, with no override", () => {
    const out: LintFinding[] = [];
    checkFlashing({ qa: { flash: { spikes: 20, spike_times_s: [0.1, 0.3], flash_rate_max: 5, flash_window: { start_s: 0.13, end_s: 1.07 } } } }, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "flashing", severity: "error", message: expect.stringMatching(/5 times in one second at 0\.13–1\.07s .*red flashes not covered/) });
  });

  it("warns on single-frame spikes and is silent when clean or unmeasured", () => {
    const out: LintFinding[] = [];
    checkFlashing({ qa: { flash: { spikes: 1, spike_times_s: [1.467], flash_rate_max: 1 } } }, out);
    expect(out).toEqual([expect.objectContaining({ id: "flashing", severity: "warning", message: expect.stringMatching(/1 single-frame luma spike\(s\) at 1\.47s/) })]);
    const none: LintFinding[] = [];
    checkFlashing({ qa: { flash: { spikes: 0, spike_times_s: [], flash_rate_max: 2 } } }, none);
    checkFlashing({ qa: {} }, none);
    checkFlashing(undefined, none);
    expect(none).toEqual([]);
  });
});
