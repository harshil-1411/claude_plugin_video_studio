/**
 * test: golden-frame regression test for a rendered project. Samples frames of dist/reel.mp4 and
 * compares them (SSIM) with the golden frames stored in the project; `update` re-records them.
 *
 * STUB (coordinator): the golden/diff agent implements it and may extend GoldenResult.
 */

export interface GoldenResult {
  status: "pass" | "fail" | "updated" | "missing";
  report_json: string;
  report_md: string;
}

export async function testProject(_projectDir: string, _opts: { quality?: "preview" | "final"; update?: boolean } = {}): Promise<GoldenResult> {
  throw new Error("not implemented: testProject");
}

export function formatGolden(_r: GoldenResult): string {
  throw new Error("not implemented: formatGolden");
}
