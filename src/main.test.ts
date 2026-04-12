import { describe, expect, it } from "vitest";
import { hasWritePermission } from "./action.js";

describe("hasWritePermission", () => {
  const tests = [
    { perm: "admin", want: true },
    { perm: "maintain", want: true },
    { perm: "write", want: true },
    { perm: "triage", want: false },
    { perm: "read", want: false },
    { perm: "none", want: false },
    { perm: "", want: false },
  ];

  for (const tt of tests) {
    it(`${tt.perm || "(empty)"} -> ${tt.want}`, () => {
      expect(hasWritePermission(tt.perm)).toBe(tt.want);
    });
  }
});
