import { describe, expect, it } from "vitest";
import {
  buildGatewayModelConfigValue,
  normalizeProviderIdForGateway,
} from "./provider-id";

describe("normalizeProviderIdForGateway", () => {
  it("strips custom prefix from domain-shaped provider ids", () => {
    expect(normalizeProviderIdForGateway("custom:cp.compshare.cn")).toBe("cp.compshare.cn");
  });

  it("keeps regular custom provider slugs intact", () => {
    expect(normalizeProviderIdForGateway("custom:local")).toBe("custom:local");
  });
});

describe("buildGatewayModelConfigValue", () => {
  it("includes an explicit provider flag for gateway model switches", () => {
    expect(buildGatewayModelConfigValue("kimi-k2.6", "kimi-for-coding"))
      .toBe("kimi-k2.6 --provider kimi-for-coding");
  });

  it("normalizes domain-shaped custom provider ids before sending to gateway", () => {
    expect(buildGatewayModelConfigValue("deepseek-v4-flash", "custom:cp.compshare.cn"))
      .toBe("deepseek-v4-flash --provider cp.compshare.cn");
  });
});
