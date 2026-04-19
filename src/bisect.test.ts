import { describe, expect, it } from "vitest";
import { split } from "./bisect.js";

describe("split", () => {
  const tests = [
    { name: "empty", input: [] as number[], left: [], right: [] },
    { name: "single", input: [1], left: [1], right: [] },
    { name: "two elements", input: [1, 2], left: [1], right: [2] },
    { name: "three elements", input: [1, 2, 3], left: [1, 2], right: [3] },
    {
      name: "four elements",
      input: [10, 20, 30, 40],
      left: [10, 20],
      right: [30, 40],
    },
    {
      name: "five elements",
      input: [1, 2, 3, 4, 5],
      left: [1, 2, 3],
      right: [4, 5],
    },
    {
      name: "six elements",
      input: [1, 2, 3, 4, 5, 6],
      left: [1, 2, 3],
      right: [4, 5, 6],
    },
  ];

  for (const tt of tests) {
    it(tt.name, () => {
      const [left, right] = split(tt.input);
      expect(left).toEqual(tt.left);
      expect(right).toEqual(tt.right);
    });
  }
});
