import { describe, expect, it } from "vitest";

import { MIN_PASSWORD_LENGTH, passwordProblem } from "../src/auth/password.ts";

describe("password rules", () => {
  it("take 8 characters or more", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordProblem("1234567")).toBe("Use at least 8 characters.");
    expect(passwordProblem("12345678")).toBeNull();
    expect(passwordProblem("x".repeat(257))).toMatch(/256/);
  });
});
