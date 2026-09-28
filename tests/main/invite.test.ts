import { describe, expect, it } from "vitest";
import { buildInviteLink, generateSecret, parseInviteLink, secretsEqual } from "../../src/main/invite";
import { inviteHost } from "../../src/shared/invite-link";

describe("generateSecret", () => {
  it("is 22 base64url chars (128 bits) and random", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateSecret()).not.toBe(a);
  });
});

describe("secretsEqual", () => {
  it("compares equal and unequal secrets", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
  });
});

describe("invite links", () => {
  it("builds from a tunnel url", () => {
    expect(buildInviteLink("https://a-b.trycloudflare.com", "S3cret")).toBe(
      "https://a-b.trycloudflare.com/join#S3cret",
    );
  });
  it("strips a trailing slash on the tunnel url", () => {
    expect(buildInviteLink("https://a.trycloudflare.com/", "x")).toBe("https://a.trycloudflare.com/join#x");
  });
  it("parses https to wss", () => {
    expect(parseInviteLink("https://a-b.trycloudflare.com/join#S3cret")).toEqual({
      hubUrl: "wss://a-b.trycloudflare.com/hub",
      secret: "S3cret",
    });
  });
  it("parses http to ws (local testing)", () => {
    expect(parseInviteLink("http://127.0.0.1:7420/join#abc")).toEqual({
      hubUrl: "ws://127.0.0.1:7420/hub",
      secret: "abc",
    });
  });
  it("tolerates surrounding whitespace", () => {
    expect(parseInviteLink("  https://a.trycloudflare.com/join#abc \n")?.secret).toBe("abc");
  });
  it("rejects malformed links", () => {
    expect(parseInviteLink("not a url")).toBeNull();
    expect(parseInviteLink("https://a.trycloudflare.com/join")).toBeNull();
    expect(parseInviteLink("https://a.trycloudflare.com/other#abc")).toBeNull();
    expect(parseInviteLink("ftp://a.trycloudflare.com/join#abc")).toBeNull();
  });
});

describe("inviteHost", () => {
  it("returns the host (and port) of a valid invite", () => {
    expect(inviteHost("https://a-b.trycloudflare.com/join#S")).toBe("a-b.trycloudflare.com");
    expect(inviteHost(" http://127.0.0.1:7420/join#abc ")).toBe("127.0.0.1:7420");
  });
  it("returns null for an invalid invite", () => {
    expect(inviteHost("not a url")).toBeNull();
    expect(inviteHost("https://a.trycloudflare.com/join")).toBeNull();
    expect(inviteHost("javascript:alert(1)//join#x")).toBeNull();
  });
});
