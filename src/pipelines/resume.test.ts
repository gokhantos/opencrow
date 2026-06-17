import { test, expect, describe } from "bun:test";
import { classifyResume, MAX_RESUME_ATTEMPTS } from "./resume";

describe("classifyResume", () => {
  test("resumes a run that has not exhausted its attempt budget", () => {
    expect(classifyResume(0)).toBe("resume");
    expect(classifyResume(1)).toBe("resume");
    expect(classifyResume(MAX_RESUME_ATTEMPTS - 1)).toBe("resume");
  });

  test("fails a run at or beyond the attempt cap", () => {
    expect(classifyResume(MAX_RESUME_ATTEMPTS)).toBe("fail");
    expect(classifyResume(MAX_RESUME_ATTEMPTS + 5)).toBe("fail");
  });

  test("the cap boundary is exactly MAX_RESUME_ATTEMPTS", () => {
    // The (MAX-1)th interrupted boot still resumes; the MAX-th gives up. This is
    // the contract that bounds a poison-step deploy loop.
    expect(classifyResume(2)).toBe("resume");
    expect(classifyResume(3)).toBe("fail");
    expect(MAX_RESUME_ATTEMPTS).toBe(3);
  });
});
