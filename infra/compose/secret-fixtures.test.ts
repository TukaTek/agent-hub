import { describe, expect, it } from "vitest";
import { deterministicSecretFixture } from "./secret-fixtures.js";

describe("deterministicSecretFixture", () => {
  it("generates stable, distinct, URI-safe 64-character hexadecimal values at runtime", () => {
    const labels = ["postgres", "auth", "encryption", "screen", "backup", "provider"];
    const fixtures = labels.map(deterministicSecretFixture);

    expect(fixtures).toHaveLength(new Set(fixtures).size);
    for (const [index, fixture] of fixtures.entries()) {
      expect(fixture).toHaveLength(64);
      expect(fixture).toMatch(/^[0-9a-f]+$/);
      expect(fixture).toBe(deterministicSecretFixture(labels[index]!));
      expect(fixture).not.toMatch(/[@:/#?%]/);
      expect(fixture).not.toMatch(/change|replace|placeholder|example|test|default/i);
    }
  });
});
