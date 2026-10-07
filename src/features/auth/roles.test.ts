import { describe, expect, it } from "vitest";
import { homePathFor, primaryRole } from "./roles";

describe("role priority", () => {
  it("picks the highest-privilege role", () => {
    expect(primaryRole(["citizen", "officer"])).toBe("officer");
    expect(primaryRole(["citizen", "clinician", "admin"])).toBe("admin");
    expect(primaryRole(["citizen"])).toBe("citizen");
  });

  it("returns null with no roles", () => {
    expect(primaryRole([])).toBeNull();
  });

  it("maps roles to their home path", () => {
    expect(homePathFor(["citizen"])).toBe("/dashboard");
    expect(homePathFor(["citizen", "clinician"])).toBe("/clinician");
    expect(homePathFor(["citizen", "officer"])).toBe("/officer");
    expect(homePathFor(["citizen", "admin"])).toBe("/admin");
  });

  it("sends role-less users to /forbidden", () => {
    expect(homePathFor([])).toBe("/forbidden");
  });
});
