import { describe, expect, it } from "vitest";
import { rateKeyIp } from "../../src/core/ip";

describe("rateKeyIp", () => {
  it("keeps an IPv4 address as is", () => {
    expect(rateKeyIp("203.0.113.7")).toBe("203.0.113.7");
  });
  it("keys IPv6 on its /64: every address of one customer subnet shares a key", () => {
    const a = rateKeyIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(rateKeyIp("2001:db8:1:2::1")).toBe(a);
    expect(rateKeyIp("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(a);
    expect(rateKeyIp("2001:db8:1:3::1")).not.toBe(a);
  });
  it("expands :: wherever it is", () => {
    expect(rateKeyIp("::1")).toBe("0:0:0:0::/64");
    expect(rateKeyIp("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(rateKeyIp("2001:db8::5:6:7")).toBe("2001:db8:0:0::/64");
    expect(rateKeyIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
  it("treats an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(rateKeyIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
  it("is idempotent", () => {
    for (const ip of ["203.0.113.7", "2001:db8:1:2::1", "::1", "::ffff:203.0.113.7"]) expect(rateKeyIp(rateKeyIp(ip))).toBe(rateKeyIp(ip));
  });
  it("gives one shared key for a missing or malformed header", () => {
    expect(rateKeyIp(undefined)).toBe("unknown");
    expect(rateKeyIp("")).toBe("unknown");
    expect(rateKeyIp("not-an-ip")).toBe("unknown");
    expect(rateKeyIp("1:2:3:4:5:6:7:8:9")).toBe("unknown");
    expect(rateKeyIp("1::2::3")).toBe("unknown");
    expect(rateKeyIp("999.1.1.1")).toBe("unknown");
  });
});
