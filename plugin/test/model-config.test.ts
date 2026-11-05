import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";

describe("model configuration", () => {
  it("defaults review and rewrite to DeepSeek V4.1 Flash #high", () => {
    const model = {
      providerID: "ollama-cloud",
      id: "deepseek-v4.1-flash:1017",
      variant: "high",
    };
    expect(DEFAULT_CONFIG.review.model).toEqual(model);
    expect(DEFAULT_CONFIG.rewrite.model).toEqual(model);
    expect(JSON.stringify(DEFAULT_CONFIG)).not.toContain("glm");
  });

  it("keeps the variant when a patch only changes the provider or id", () => {
    const patched = mergeConfig(DEFAULT_CONFIG, {
      review: { model: { id: "deepseek-v4.1-flash:1017" } },
    });
    expect(patched.review.model.variant).toBe("high");
  });

  it("lets a patch override the variant", () => {
    const patched = mergeConfig(DEFAULT_CONFIG, {
      rewrite: {
        model: {
          providerID: "ollama-cloud",
          id: "deepseek-v4.1-flash:1017",
          variant: "max",
        },
      },
    });
    expect(patched.rewrite.model.variant).toBe("max");
    expect(patched.review.model.variant).toBe("high");
  });
});
