/**
 * verify: claim-coverage report for a planned project. Which ContentIR claims each scene cites,
 * which claims no scene covers, and which scenes make statements without grounding, reusing
 * validateVideoSpecSemantics. Writes qa/verify.{json,md}.
 *
 * STUB (coordinator): the verify agent implements it and may extend VerifyResult.
 */

export interface VerifyResult {
  status: "pass" | "warn" | "fail";
  report_json: string;
  report_md: string;
}

export async function verifyProject(_projectDir: string): Promise<VerifyResult> {
  throw new Error("not implemented: verifyProject");
}

/** One-screen summary for the tool result. */
export function formatVerify(_r: VerifyResult): string {
  throw new Error("not implemented: formatVerify");
}
