import { describe, expect, it } from "vitest";
import { modelHeaders, validateModelEndpoint } from "../src/util/endpoint.js";

describe("model endpoint boundary", () => {
  it.each(["https://attacker.example/api", "http://ollama.com/api", "https://ollama.com.evil.test", "https://user:pass@ollama.com", "file:///etc/passwd"])("refuses an untrusted endpoint %s", (value) => {
    expect(() => validateModelEndpoint(value)).toThrow();
  });
  it("supports local models without forwarding the cloud credential", () => {
    expect(() => validateModelEndpoint("http://127.0.0.1:11434")).not.toThrow();
    expect(modelHeaders("http://localhost:11434", "synthetic-key").authorization).toBeUndefined();
    expect(modelHeaders("https://ollama.com/api/chat", "synthetic-key").authorization).toBe("Bearer synthetic-key");
  });
});
