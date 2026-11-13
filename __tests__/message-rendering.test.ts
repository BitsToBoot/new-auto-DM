/**
 * Bug 7 (one canonical renderer) and Bug 12 (UTF-8 byte limit).
 */
import { describe, it, expect } from "vitest";
import {
  META_MESSAGE_MAX_BYTES,
  MessageRenderError,
  renderDmMessage,
  selectMessageVariation,
  utf8ByteLength,
  validateMessageTemplate,
} from "@/lib/delivery/renderer";
import { buildTrackedUrl } from "@/lib/tracking/message";
import * as trackingMessage from "@/lib/tracking/message";

function renderError(template: string, context = {}) {
  try {
    renderDmMessage(template, context);
  } catch (error) {
    expect(error).toBeInstanceOf(MessageRenderError);
    return error as MessageRenderError;
  }
  throw new Error("expected renderDmMessage to throw");
}

describe("Bug 7 — canonical placeholder rendering", () => {
  it("is the only rendering implementation (the old tracking renderer is gone)", () => {
    expect("renderMessageWithTracking" in trackingMessage).toBe(false);
  });

  it("renders {username} identically wherever it appears", () => {
    expect(renderDmMessage("Hi {username}", { username: "alice" })).toBe("Hi @alice");
    expect(renderDmMessage("Hi {USERNAME}", { username: "@alice" })).toBe("Hi @alice");
    expect(renderDmMessage("{username} {username}!", { username: "bob" })).toBe("@bob @bob!");
  });

  it("uses a neutral fallback when the username is missing", () => {
    expect(renderDmMessage("Hey {username}!", {})).toBe("Hey there!");
    expect(renderDmMessage("Hey {username}!", { username: "   " })).toBe("Hey there!");
    expect(renderDmMessage("Hi {name}", {})).toBe("Hi friend");
    expect(renderDmMessage("Hi {name}", { username: "carol" })).toBe("Hi carol");
    expect(renderDmMessage("Hi {name}", { username: "carol", displayName: "Carol D" })).toBe("Hi Carol D");
  });

  it("substitutes every {link} with the tracked URL", () => {
    const trackedUrl = buildTrackedUrl("abc", "https://app.test", { deliveryJobId: "job_1", signature: "f".repeat(32) });
    expect(renderDmMessage("{link} and again {LINK}", { trackedUrl })).toBe(`${trackedUrl} and again ${trackedUrl}`);
  });

  it("never sends a literal {link} when no tracked link exists", () => {
    expect(renderError("Get it: {link}").code).toBe("MISSING_TRACKED_LINK");
  });

  it("rejects unknown and malformed-looking placeholders instead of sending them", () => {
    expect(renderError("Hi {first_name}").code).toBe("UNSUPPORTED_PLACEHOLDER");
    expect(renderError("Use code {coupon_code}").message).toContain("{coupon_code}");
  });

  it("leaves non-placeholder braces alone", () => {
    expect(renderDmMessage("Sizes: {S, M, L} and {} ok", {})).toBe("Sizes: {S, M, L} and {} ok");
  });

  it("rejects empty templates", () => {
    expect(renderError("   ").code).toBe("EMPTY_MESSAGE");
  });

  it("preserves Hindi and emoji", () => {
    expect(renderDmMessage("नमस्ते {username} 🙏🏽✨", { username: "राहुल" })).toBe("नमस्ते @राहुल 🙏🏽✨");
  });

  it("is deterministic for retries", () => {
    const context = { username: "dave", trackedUrl: "https://app.test/r/x?d=1&s=2" };
    expect(renderDmMessage("{username} {link}", context)).toBe(renderDmMessage("{username} {link}", context));
  });
});

describe("variation selection", () => {
  const variations = [
    { id: "v1", message: "One", isActive: true },
    { id: "v2", message: "Two", isActive: true },
    { id: "v3", message: "Off", isActive: false },
  ];

  it("returns the default when no active variation exists", () => {
    expect(selectMessageVariation([], "Default", "c1")).toEqual({ variationId: null, template: "Default" });
    expect(selectMessageVariation([variations[2]], "Default", "c1")).toEqual({ variationId: null, template: "Default" });
  });

  it("is stable for the same seed and never picks inactive variations", () => {
    for (let i = 0; i < 50; i++) {
      const first = selectMessageVariation(variations, "Default", `comment_${i}`);
      expect(selectMessageVariation(variations, "Default", `comment_${i}`)).toEqual(first);
      expect(first.variationId).not.toBe("v3");
    }
  });
});

describe("Bug 12 — Meta's limit is 1000 UTF-8 bytes, not 1000 characters", () => {
  it("accepts plain ASCII at exactly 1000 bytes", () => {
    const message = "a".repeat(1000);
    expect(utf8ByteLength(message)).toBe(1000);
    expect(renderDmMessage(message)).toBe(message);
  });

  it("rejects ASCII over 1000 bytes without truncating", () => {
    const error = renderError("a".repeat(1001));
    expect(error.code).toBe("MESSAGE_TOO_LONG");
    expect(error.message).toContain("1001 UTF-8 bytes");
  });

  it("counts Hindi as 3 bytes per character", () => {
    const hindi = "क".repeat(333); // 999 bytes, 333 chars
    expect(utf8ByteLength(hindi)).toBe(999);
    expect(renderDmMessage(hindi)).toBe(hindi);
    expect(renderError("क".repeat(334)).code).toBe("MESSAGE_TOO_LONG"); // 1002 bytes, 334 chars
  });

  it("counts emoji and other multi-byte Unicode correctly", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("🙏🏽")).toBe(8);
    expect(renderDmMessage("😀".repeat(250))).toHaveLength(500); // 1000 bytes, 500 UTF-16 units
    expect(renderError("😀".repeat(250) + "!").code).toBe("MESSAGE_TOO_LONG");
  });

  it("validates after placeholders and the tracked URL are filled in", () => {
    const trackedUrl = "https://app.test/r/" + "x".repeat(81); // 100 bytes
    const template = "a".repeat(895) + "{link}"; // 895 + 100 = 995
    expect(utf8ByteLength(renderDmMessage(template, { trackedUrl }))).toBe(995);
    expect(renderError("a".repeat(901) + "{link}", { trackedUrl }).code).toBe("MESSAGE_TOO_LONG");
    expect(renderError("a".repeat(995) + "{username}", { username: "abcdef" }).code).toBe("MESSAGE_TOO_LONG");
  });

  it("exact boundary: 1000 passes, 1001 fails", () => {
    expect(() => renderDmMessage("é".repeat(500))).not.toThrow(); // 1000 bytes
    expect(renderError("é".repeat(500) + "a").code).toBe("MESSAGE_TOO_LONG");
    expect(META_MESSAGE_MAX_BYTES).toBe(1000);
  });

  describe("save-time template validation (worst-case expansion)", () => {
    const options = { hasTrackedLink: true, maxTrackedUrlLength: 120 };

    it("accepts a template that cannot exceed the limit", () => {
      const result = validateMessageTemplate("Hi {username}, grab it: {link}", options);
      expect(result.valid).toBe(true);
    });

    it("rejects a variation that only exceeds the limit once rendered", () => {
      // 870 ASCII + {link} (120) + {username} (31) = 1021 bytes worst case.
      const result = validateMessageTemplate("a".repeat(870) + "{link}{username}", options);
      expect(result).toMatchObject({ valid: false, code: "MESSAGE_TOO_LONG" });
    });

    it("rejects Hindi copy under 1000 characters but over 1000 bytes", () => {
      const result = validateMessageTemplate("नमस्ते ".repeat(60), options);
      expect(result).toMatchObject({ valid: false, code: "MESSAGE_TOO_LONG" });
    });

    it("assumes worst-case 4-byte characters for {name}", () => {
      const result = validateMessageTemplate("a".repeat(900) + "{name}", options);
      expect(result).toMatchObject({ valid: false, code: "MESSAGE_TOO_LONG" }); // 900 + 120
    });

    it("counts a raw destination URL as the longer tracked URL", () => {
      const destinationUrl = "https://x.co/";
      const template = "a".repeat(900) + " " + destinationUrl;
      expect(validateMessageTemplate(template, { ...options, destinationUrl }).valid).toBe(false);
      expect(validateMessageTemplate(template, { ...options, hasTrackedLink: false }).valid).toBe(true);
    });

    it("rejects {link} without a tracked link and unsupported placeholders", () => {
      expect(validateMessageTemplate("{link}", { ...options, hasTrackedLink: false })).toMatchObject({
        valid: false,
        code: "MISSING_TRACKED_LINK",
      });
      expect(validateMessageTemplate("Hi {first_name}", options)).toMatchObject({
        valid: false,
        code: "UNSUPPORTED_PLACEHOLDER",
      });
    });
  });
});
