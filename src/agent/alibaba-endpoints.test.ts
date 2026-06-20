import { describe, expect, it } from "bun:test";
import {
  ALIBABA_TOKEN_PLAN_HOST,
  resolveAlibabaEndpoint,
} from "./alibaba-endpoints";

const OPENAI_SUFFIX = "/compatible-mode/v1";
const ANTHROPIC_SUFFIX = "/apps/anthropic";

describe("resolveAlibabaEndpoint", () => {
  describe("default host (no override)", () => {
    for (const override of [undefined, null, "", "   "] as const) {
      it(`openai default for override=${JSON.stringify(override)}`, () => {
        expect(resolveAlibabaEndpoint("openai", override)).toBe(
          `${ALIBABA_TOKEN_PLAN_HOST}${OPENAI_SUFFIX}`,
        );
      });

      it(`anthropic default for override=${JSON.stringify(override)}`, () => {
        expect(resolveAlibabaEndpoint("anthropic", override)).toBe(
          `${ALIBABA_TOKEN_PLAN_HOST}${ANTHROPIC_SUFFIX}`,
        );
      });
    }

    it("uses the documented token-plan host by default", () => {
      expect(resolveAlibabaEndpoint("openai")).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      );
      expect(resolveAlibabaEndpoint("anthropic")).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      );
    });
  });

  describe("bare host override", () => {
    const host = "https://token-plan.ap-southeast-1.maas.aliyuncs.com";

    it("appends the openai suffix", () => {
      expect(resolveAlibabaEndpoint("openai", host)).toBe(
        `${host}${OPENAI_SUFFIX}`,
      );
    });

    it("appends the anthropic suffix", () => {
      expect(resolveAlibabaEndpoint("anthropic", host)).toBe(
        `${host}${ANTHROPIC_SUFFIX}`,
      );
    });
  });

  describe("full-URL override normalization", () => {
    it("strips a /compatible-mode/v1 suffix before applying anthropic", () => {
      const override =
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
      expect(resolveAlibabaEndpoint("anthropic", override)).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      );
    });

    it("strips an /apps/anthropic suffix before applying openai", () => {
      const override =
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
      expect(resolveAlibabaEndpoint("openai", override)).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      );
    });

    it("strips a bare /v1 suffix", () => {
      const override =
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/v1";
      expect(resolveAlibabaEndpoint("openai", override)).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      );
    });

    it("does not double the suffix when override already matches the kind", () => {
      const override =
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
      expect(resolveAlibabaEndpoint("openai", override)).toBe(override);
    });
  });

  describe("region portability", () => {
    const host = "https://token-plan.us-east-1.maas.aliyuncs.com";

    it("preserves the region for the openai kind", () => {
      expect(resolveAlibabaEndpoint("openai", host)).toBe(
        `${host}${OPENAI_SUFFIX}`,
      );
    });

    it("preserves the region for the anthropic kind", () => {
      expect(resolveAlibabaEndpoint("anthropic", host)).toBe(
        `${host}${ANTHROPIC_SUFFIX}`,
      );
    });

    it("preserves the region when normalizing a full URL", () => {
      const override =
        "https://token-plan.us-east-1.maas.aliyuncs.com/apps/anthropic";
      expect(resolveAlibabaEndpoint("openai", override)).toBe(
        "https://token-plan.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
      );
    });
  });

  describe("override validation", () => {
    it("rejects an unparseable / scheme-less host", () => {
      expect(() =>
        resolveAlibabaEndpoint("openai", "token-plan.maas.aliyuncs.com"),
      ).toThrow(/valid absolute URL/);
    });

    it("rejects a malformed scheme typo", () => {
      expect(() =>
        resolveAlibabaEndpoint("openai", "htps://token-plan.maas.aliyuncs.com"),
      ).toThrow(/http\(s\) scheme/);
    });

    it("rejects a non-http(s) scheme", () => {
      expect(() =>
        resolveAlibabaEndpoint("anthropic", "ftp://token-plan.maas.aliyuncs.com"),
      ).toThrow(/http\(s\) scheme/);
    });

    it("rejects an override with embedded credentials", () => {
      expect(() =>
        resolveAlibabaEndpoint("openai", "https://user:pass@evil.example.com"),
      ).toThrow(/embedded credentials/);
    });
  });

  describe("trailing slash handling", () => {
    it("strips a single trailing slash on a bare host", () => {
      expect(
        resolveAlibabaEndpoint(
          "openai",
          "https://token-plan.ap-southeast-1.maas.aliyuncs.com/",
        ),
      ).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      );
    });

    it("strips multiple trailing slashes", () => {
      expect(
        resolveAlibabaEndpoint(
          "anthropic",
          "https://token-plan.ap-southeast-1.maas.aliyuncs.com///",
        ),
      ).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      );
    });

    it("strips trailing slashes after a known suffix", () => {
      expect(
        resolveAlibabaEndpoint(
          "anthropic",
          "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/",
        ),
      ).toBe(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      );
    });
  });
});
