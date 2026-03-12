import { describe, it, expect } from "bun:test";
import {
  toolError,
  inputError,
  notFoundError,
  rateLimitError,
  serviceError,
  timeoutError,
  permissionError,
} from "./error-helpers";

describe("error-helpers", () => {
  describe("toolError", () => {
    it("returns isError true with the given code", () => {
      const result = toolError("something went wrong", "INTERNAL");
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe("INTERNAL");
      expect(result.output).toBe("something went wrong");
    });

    it("sets retriable from opts", () => {
      const result = toolError("fail", "EXTERNAL_SERVICE", { retriable: true });
      expect(result.retriable).toBe(true);
    });

    it("sets retryAfterMs from opts", () => {
      const result = toolError("fail", "RATE_LIMITED", { retryAfterMs: 5000 });
      expect(result.retryAfterMs).toBe(5000);
    });

    it("omits retriable when not provided", () => {
      const result = toolError("fail", "INTERNAL");
      expect(result.retriable).toBeUndefined();
    });

    it("omits retryAfterMs when not provided", () => {
      const result = toolError("fail", "INTERNAL");
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("does not mutate input", () => {
      const r1 = toolError("msg", "INTERNAL", { retriable: false });
      const r2 = toolError("msg", "INTERNAL", { retriable: true });
      expect(r1.retriable).toBe(false);
      expect(r2.retriable).toBe(true);
    });
  });

  describe("inputError", () => {
    it("uses INVALID_INPUT code", () => {
      const result = inputError("bad value");
      expect(result.errorCode).toBe("INVALID_INPUT");
    });

    it("is not retriable", () => {
      const result = inputError("bad value");
      expect(result.retriable).toBe(false);
    });

    it("passes the message through", () => {
      const result = inputError("bad value");
      expect(result.output).toBe("bad value");
      expect(result.isError).toBe(true);
    });
  });

  describe("notFoundError", () => {
    it("uses NOT_FOUND code", () => {
      const result = notFoundError("item missing");
      expect(result.errorCode).toBe("NOT_FOUND");
    });

    it("is not retriable", () => {
      expect(notFoundError("x").retriable).toBe(false);
    });
  });

  describe("rateLimitError", () => {
    it("uses RATE_LIMITED code", () => {
      expect(rateLimitError("slow down").errorCode).toBe("RATE_LIMITED");
    });

    it("is retriable", () => {
      expect(rateLimitError("slow down").retriable).toBe(true);
    });

    it("sets retryAfterMs when provided", () => {
      expect(rateLimitError("slow down", 30_000).retryAfterMs).toBe(30_000);
    });

    it("leaves retryAfterMs undefined when not provided", () => {
      expect(rateLimitError("slow down").retryAfterMs).toBeUndefined();
    });
  });

  describe("serviceError", () => {
    it("uses EXTERNAL_SERVICE code", () => {
      expect(serviceError("network fail").errorCode).toBe("EXTERNAL_SERVICE");
    });

    it("is retriable by default", () => {
      expect(serviceError("network fail").retriable).toBe(true);
    });

    it("can be marked non-retriable", () => {
      expect(serviceError("network fail", false).retriable).toBe(false);
    });
  });

  describe("timeoutError", () => {
    it("uses TIMEOUT code", () => {
      expect(timeoutError("timed out").errorCode).toBe("TIMEOUT");
    });

    it("is retriable", () => {
      expect(timeoutError("timed out").retriable).toBe(true);
    });
  });

  describe("permissionError", () => {
    it("uses PERMISSION_DENIED code", () => {
      expect(permissionError("access denied").errorCode).toBe(
        "PERMISSION_DENIED",
      );
    });

    it("is not retriable", () => {
      expect(permissionError("access denied").retriable).toBe(false);
    });
  });
});
