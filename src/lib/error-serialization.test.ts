import { describe, expect, it } from "bun:test";
import { getErrorMessage, serializeError } from "./error-serialization";

describe("serializeError", () => {
  it("serializes an Error instance to a plain object", () => {
    const err = new Error("boom");
    const result = serializeError(err);
    expect(result.message).toBe("boom");
    expect(result.name).toBe("Error");
    expect(typeof result.stack).toBe("string");
  });

  it("preserves custom Error subclass name", () => {
    class ValidationError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ValidationError";
      }
    }
    const result = serializeError(new ValidationError("invalid"));
    expect(result.name).toBe("ValidationError");
    expect(result.message).toBe("invalid");
  });

  it("includes cause when present on the Error", () => {
    const cause = new Error("root cause");
    const err = new Error("wrapper", { cause });
    const result = serializeError(err);
    expect(result.cause).toBe(cause);
  });

  it("omits cause when not set on the Error", () => {
    const err = new Error("no cause");
    const result = serializeError(err);
    expect("cause" in result).toBe(false);
  });

  it("serializes a string to message", () => {
    const result = serializeError("something failed");
    expect(result).toEqual({ message: "something failed" });
  });

  it("serializes a number to message via String()", () => {
    const result = serializeError(404);
    expect(result).toEqual({ message: "404" });
  });

  it("serializes null to message", () => {
    const result = serializeError(null);
    expect(result).toEqual({ message: "null" });
  });

  it("serializes undefined to message", () => {
    const result = serializeError(undefined);
    expect(result).toEqual({ message: "undefined" });
  });

  it("serializes a plain object via String()", () => {
    const result = serializeError({ code: 5 });
    expect(result).toEqual({ message: "[object Object]" });
  });
});

describe("getErrorMessage", () => {
  it("returns message from an Error instance", () => {
    expect(getErrorMessage(new Error("hello"))).toBe("hello");
  });

  it("returns string representation for a string", () => {
    expect(getErrorMessage("raw string error")).toBe("raw string error");
  });

  it("returns string representation for a number", () => {
    expect(getErrorMessage(500)).toBe("500");
  });

  it("returns string representation for null", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("returns string representation for undefined", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});
