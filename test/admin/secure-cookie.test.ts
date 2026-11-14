import { describe, expect, it } from "vitest";
import { cookieName, secureCookie } from "../../src/admin/session";

describe("secureCookie", () => {
  it("keeps Secure on every https request, loopback included", () => {
    expect(secureCookie("https://pay.example.com/admin/login")).toBe(true);
    expect(secureCookie("https://localhost:8787/admin/login")).toBe(true);
  });

  it("drops Secure only for plain http to a loopback host (wrangler dev)", () => {
    expect(secureCookie("http://localhost:8787/admin/login")).toBe(false);
    expect(secureCookie("http://127.0.0.1:8787/pos")).toBe(false);
    expect(secureCookie("http://[::1]:8787/admin")).toBe(false);
  });

  it("keeps Secure for plain http to any other host", () => {
    expect(secureCookie("http://pay.example.com/admin/login")).toBe(true);
    expect(secureCookie("http://localhost.evil.test/admin/login")).toBe(true);
    expect(secureCookie("http://192.168.1.5:8787/admin/login")).toBe(true);
  });
});

describe("cookieName", () => {
  it("prefixes __Host- whenever the cookie is Secure", () => {
    expect(cookieName("0c_session", "https://pay.example.com/admin")).toBe("__Host-0c_session");
    expect(cookieName("0c_setup", "https://localhost:8787/admin/login")).toBe("__Host-0c_setup");
    expect(cookieName("0c_session", "http://pay.example.com/admin")).toBe("__Host-0c_session");
    expect(cookieName("0c_session", "http://localhost.evil.test/admin")).toBe("__Host-0c_session");
  });

  it("keeps the bare name only for plain http to a loopback host", () => {
    expect(cookieName("0c_session", "http://localhost:8787/admin")).toBe("0c_session");
    expect(cookieName("0c_session", "http://127.0.0.1:8787/pos")).toBe("0c_session");
    expect(cookieName("0c_setup", "http://[::1]:8787/admin/login")).toBe("0c_setup");
  });
});
