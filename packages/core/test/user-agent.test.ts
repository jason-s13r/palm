import { describe, expect, it } from "vitest";
import { userAgentClient } from "../src/user-agent.ts";

describe("userAgentClient", () => {
  it("names the app and the device when the User-Agent says", () => {
    expect(userAgentClient("Ivory/2.3 (iPhone; iOS 18.1)")).toEqual({ app: "Ivory", device: "iPhone" });
    expect(userAgentClient("Thunder/0.6.0 (Android 15)")).toEqual({ app: "Thunder", device: "Android" });
    expect(userAgentClient("Pixelfed/1 CFNetwork/1568.200.51 Darwin/24.1.0")).toEqual({ app: "Pixelfed", device: "iPhone" });
  });

  it("leaves out webviews' and libraries' names", () => {
    expect(userAgentClient("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toEqual({ app: null, device: "iPhone" });
    expect(userAgentClient("okhttp/4.12.0")).toEqual({ app: null, device: "Android" });
    expect(userAgentClient("Dart/3.5 (dart:io)")).toEqual({ app: null, device: null });
    expect(userAgentClient(undefined)).toEqual({ app: null, device: null });
  });
});
