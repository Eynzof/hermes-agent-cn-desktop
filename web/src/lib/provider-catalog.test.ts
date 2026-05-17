import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalJSON } from "./transport";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildProviderConfigUpdate,
  fetchRemoteProviderCatalog,
  getProviderEntry,
  providerHasSavedCredentials,
  sortProvidersForCnEdition,
  TOP5_PROVIDER_IDS,
  type ProviderPreset,
} from "./provider-catalog";

vi.mock("./transport", () => ({
  fetchExternalJSON: vi.fn(),
}));

const mockedFetchExternalJSON = vi.mocked(fetchExternalJSON);

beforeEach(() => {
  mockedFetchExternalJSON.mockReset();
});

describe("provider catalog config updates", () => {
  it("writes catalog providers as canonical providers instead of custom slugs", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "cp.compshare.cn");
    expect(preset).toBeTruthy();

    const config = buildProviderConfigUpdate(
      { model: "old-model" },
      preset!,
      {
        apiKey: "test-key",
        baseUrl: "https://cp.compshare.cn/v1",
        model: "glm-5.1",
      },
    );

    expect(config.model).toMatchObject({
      provider: "cp.compshare.cn",
      default: "glm-5.1",
      base_url: "https://cp.compshare.cn/v1",
      api_mode: "chat_completions",
    });
    expect(config.providers["cp.compshare.cn"]).toMatchObject({
      name: "优云智算 · Coding Plan",
      api_key: "test-key",
      model: "glm-5.1",
    });
    expect(config.model.provider).not.toMatch(/^custom:/);
  });

  it.each(TOP5_PROVIDER_IDS)("ships Top 5 provider %s with intact required fields", (id) => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((p) => p.id === id);
    expect(preset, `Top 5 provider "${id}" must exist in BUILTIN_PROVIDER_CATALOG`).toBeTruthy();
    expect(preset!.name).toBeTruthy();
    expect(preset!.baseUrl).toMatch(/^https?:\/\//);
    expect(preset!.docsUrl, `${id} should expose a docs URL for the CN edition`).toMatch(/^https?:\/\//);
    expect(preset!.defaultModel).toBeTruthy();
    expect(preset!.region, `${id} is a Chinese-edition feature provider`).toBe("cn");
    expect(
      preset!.models.some((m) => m.id === preset!.defaultModel),
      `${id}.defaultModel "${preset!.defaultModel}" must appear in models[]`,
    ).toBe(true);
  });

  it("orders Top 5 first, then other CN, then global", () => {
    const sorted = sortProvidersForCnEdition(BUILTIN_PROVIDER_CATALOG.providers);
    const sortedIds = sorted.map((p) => p.id);
    expect(sortedIds.slice(0, TOP5_PROVIDER_IDS.length)).toEqual([...TOP5_PROVIDER_IDS]);
    const remainder = sorted.slice(TOP5_PROVIDER_IDS.length);
    const firstGlobalIdx = remainder.findIndex((p) => p.region === "global");
    if (firstGlobalIdx !== -1) {
      const cnAfterGlobal = remainder.slice(firstGlobalIdx).some((p) => p.region === "cn");
      expect(cnAfterGlobal, "no cn-region provider should come after a global provider").toBe(false);
    }
  });

  it("places injected custom providers among the catalog without disturbing Top 5 order", () => {
    const custom: ProviderPreset = {
      id: "custom:hunyuan-cloud-tencent-com",
      name: "腾讯混元（自定义）",
      vendor: "自定义",
      region: "cn",
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: "hunyuan-turbos-latest",
      models: [{ id: "hunyuan-turbos-latest", supportsTools: true }],
      isCustom: true,
    };
    const sorted = sortProvidersForCnEdition([...BUILTIN_PROVIDER_CATALOG.providers, custom]);
    expect(sorted.slice(0, TOP5_PROVIDER_IDS.length).map((p) => p.id)).toEqual([...TOP5_PROVIDER_IDS]);
    expect(sorted.find((p) => p.id === custom.id)).toBeTruthy();
  });

  it("preserves an existing provider key when saving metadata only", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers[0]!;
    const config = buildProviderConfigUpdate(
      {
        providers: {
          [preset.id]: {
            api_key: "existing-key",
            base_url: "https://old.example/v1",
          },
        },
      },
      preset,
      {
        apiKey: "",
        baseUrl: preset.baseUrl,
        model: preset.defaultModel,
      },
    );

    expect(getProviderEntry(config, preset.id).api_key).toBe("existing-key");
    expect(providerHasSavedCredentials(config, preset.id)).toBe(true);
  });

  it("loads remote catalog through fetchExternalJSON timeout path", async () => {
    mockedFetchExternalJSON.mockResolvedValue({
      version: "remote-v1",
      providers: [
        {
          id: "remote-provider",
          name: "Remote Provider",
          vendor: "Remote",
          region: "global",
          baseUrl: "https://api.example.com/v1",
          apiMode: "chat_completions",
          transport: "openai_chat",
          apiKeyLabel: "REMOTE_API_KEY",
          defaultModel: "remote-model",
          models: [{ id: "remote-model" }],
        },
      ],
    });

    const catalog = await fetchRemoteProviderCatalog("https://cdn.example.com/catalog.json");

    expect(mockedFetchExternalJSON).toHaveBeenCalledWith(
      "https://cdn.example.com/catalog.json",
      { headers: { Accept: "application/json" } },
    );
    expect(catalog).toMatchObject({
      version: "remote-v1",
      providers: [
        {
          id: "remote-provider",
          defaultModel: "remote-model",
        },
      ],
    });
  });
});
