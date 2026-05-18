import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useConfig, useModelInfo, useSaveConfig } from "@/hooks/use-config";
import { useDeleteEnv, useEnvVars, useRevealEnv, useSetEnv } from "@/hooks/use-env";
import { useGateway } from "@/hooks/use-gateway";
import { useProviderModels } from "@/hooks/use-provider-models";
import type { ProviderProbeResult } from "@hermes/protocol";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildCurrentModelConfigUpdate,
  buildProviderConfigUpdate,
  buildProviderSettingsUpdate,
  getProviderEntry,
  providerHasSavedCredentials,
  sortProvidersForCnEdition,
  TOP5_PROVIDER_IDS,
  type ProviderPreset,
} from "@/lib/provider-catalog";
import { useProviderCatalog } from "@/hooks/use-provider-catalog";
import { ModelCombobox } from "@/components/settings/model-combobox";
import { rememberLastUsedModel } from "@/lib/last-used-model";
import type { EnvVarInfo } from "@hermes/protocol";
import { OAuthProvidersSection } from "./settings-oauth-section";
import s from "./settings.module.css";

const PROVIDER_GROUPS: { prefix: string; name: string; priority: number }[] = [
  { prefix: "NOUS_", name: "Nous Portal", priority: 0 },
  { prefix: "ANTHROPIC_", name: "Anthropic", priority: 1 },
  { prefix: "DASHSCOPE_", name: "DashScope (Qwen)", priority: 2 },
  { prefix: "HERMES_QWEN_", name: "DashScope (Qwen)", priority: 2 },
  { prefix: "DEEPSEEK_", name: "DeepSeek", priority: 3 },
  { prefix: "GOOGLE_", name: "Gemini", priority: 4 },
  { prefix: "GEMINI_", name: "Gemini", priority: 4 },
  { prefix: "GLM_", name: "GLM / Z.AI", priority: 5 },
  { prefix: "ZAI_", name: "GLM / Z.AI", priority: 5 },
  { prefix: "Z_AI_", name: "GLM / Z.AI", priority: 5 },
  { prefix: "HF_", name: "Hugging Face", priority: 6 },
  { prefix: "KIMI_", name: "Kimi / Moonshot", priority: 7 },
  { prefix: "MINIMAX_CN_", name: "MiniMax (China)", priority: 9 },
  { prefix: "MINIMAX_", name: "MiniMax", priority: 8 },
  { prefix: "OPENCODE_GO_", name: "OpenCode Go", priority: 10 },
  { prefix: "OPENCODE_ZEN_", name: "OpenCode Zen", priority: 11 },
  { prefix: "OPENROUTER_", name: "OpenRouter", priority: 12 },
  { prefix: "XIAOMI_", name: "Xiaomi MiMo", priority: 13 },
  { prefix: "COMPSHARE_", name: "优云智算 (Compshare)", priority: 14 },
];

const PROVIDER_ACTION_LOADING_MIN_MS = 450;

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getProviderGroup(key: string): string {
  for (const g of PROVIDER_GROUPS) {
    if (key.startsWith(g.prefix)) return g.name;
  }
  return "其他";
}

function getProviderPriority(name: string): number {
  return PROVIDER_GROUPS.find((g) => g.name === name)?.priority ?? 99;
}

export function ModelsSection() {
  const { data: envVars, isLoading } = useEnvVars();
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const saveConfig = useSaveConfig();
  const setEnv = useSetEnv();
  const deleteEnv = useDeleteEnv();
  const revealEnv = useRevealEnv();
  const { probeProvider, setRuntimeModel } = useGateway();
  const { catalog, message: catalogMessage, refresh: refreshCatalog } = useProviderCatalog();
  const [probeState, setProbeState] = useState<{
    providerId: string;
    status: "pending" | "ok" | "error";
    result?: ProviderProbeResult;
    message?: string;
  } | null>(null);
  const initialProvider =
    BUILTIN_PROVIDER_CATALOG.providers.find((p) => p.id === TOP5_PROVIDER_IDS[0]) ??
    BUILTIN_PROVIDER_CATALOG.providers[0];
  const [selectedProviderId, setSelectedProviderId] = useState(initialProvider?.id ?? "");
  const [providerForm, setProviderForm] = useState({
    apiKey: "",
    baseUrl: initialProvider?.baseUrl ?? "",
    model: initialProvider?.defaultModel ?? "",
  });
  // Last saved values for the selected provider. Used to compute whether the
  // form is dirty (vs. baseline) so the save button can show an idle "已保存"
  // state until the user actually changes something.
  const [savedSnapshot, setSavedSnapshot] = useState<{
    baseUrl: string;
    model: string;
    providerId: string;
  } | null>(null);
  const [savedFlashFor, setSavedFlashFor] = useState<string | null>(null);
  const [providerSavePending, setProviderSavePending] = useState(false);
  const [providerSetCurrentPending, setProviderSetCurrentPending] = useState(false);
  const [providerSaveError, setProviderSaveError] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [showEnvAdvanced, setShowEnvAdvanced] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customForm, setCustomForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
  });
  const customDialogTitleId = useId();
  const closeCustomForm = useCallback(() => {
    setShowCustomForm(false);
    setCustomForm({ name: "", baseUrl: "", apiKey: "", model: "" });
  }, []);
  useEffect(() => {
    if (!showCustomForm) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCustomForm();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showCustomForm, closeCustomForm]);

  const customProviders = useMemo<ProviderPreset[]>(() => {
    const providers = config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, any>).providers
      : null;
    if (!providers || typeof providers !== "object") return [];
    const knownIds = new Set(catalog.providers.map((p) => p.id));
    const customs: ProviderPreset[] = [];
    for (const [id, raw] of Object.entries(providers)) {
      if (knownIds.has(id) || !id.startsWith("custom:")) continue;
      const v = raw && typeof raw === "object" ? raw as Record<string, any> : {};
      const model = typeof v.model === "string" ? v.model : "";
      customs.push({
        id,
        name: typeof v.name === "string" && v.name ? v.name : id.replace(/^custom:/, ""),
        vendor: "自定义",
        region: "cn",
        baseUrl: typeof v.base_url === "string" ? v.base_url : "",
        apiMode: v.api_mode === "anthropic_messages" || v.api_mode === "codex_responses"
          ? v.api_mode : "chat_completions",
        transport: v.transport === "anthropic_messages" || v.transport === "codex_responses"
          ? v.transport : "openai_chat",
        apiKeyLabel: "API Key",
        defaultModel: model,
        models: model ? [{ id: model, supportsTools: true }] : [],
        isCustom: true,
      });
    }
    return customs;
  }, [config, catalog.providers]);

  const allProviders = useMemo(
    () => [...catalog.providers, ...customProviders],
    [catalog.providers, customProviders],
  );
  const selectedProvider = useMemo<ProviderPreset | undefined>(
    () => allProviders.find((provider) => provider.id === selectedProviderId) ?? allProviders[0],
    [allProviders, selectedProviderId],
  );
  const orderedProviders = useMemo(
    () => sortProvidersForCnEdition(allProviders),
    [allProviders],
  );
  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    if (!query) return orderedProviders;
    return orderedProviders.filter((provider) => {
      const searchable = [
        provider.name,
        provider.vendor,
        provider.id,
        provider.defaultModel,
        ...provider.models.map((model) => model.label ?? model.id),
      ].join(" ").toLowerCase();
      return searchable.includes(query);
    });
  }, [orderedProviders, providerSearch]);
  const selectedProviderEntry = selectedProvider
    ? getProviderEntry(config, selectedProvider.id)
    : {};
  const selectedHasCredentials = selectedProvider
    ? providerHasSavedCredentials(config, selectedProvider.id)
    : false;
  const currentProviderId = modelInfo?.provider ||
    (config?.model && typeof config.model === "object" && !Array.isArray(config.model)
      ? String((config.model as Record<string, unknown>).provider ?? "")
      : "");
  const configuredCount = useMemo(
    () => allProviders.filter((provider) => providerHasSavedCredentials(config, provider.id)).length,
    [allProviders, config],
  );
  const providerEnvEntries = useMemo(
    () => Object.entries(envVars ?? {})
      .filter(([, v]) => v.category === "provider")
      .sort(([aKey], [bKey]) => getProviderPriority(getProviderGroup(aKey)) - getProviderPriority(getProviderGroup(bKey))),
    [envVars],
  );
  const nonProviderGroups = useMemo(() => {
    if (!envVars) return [];
    const catLabels: Record<string, string> = { tool: "工具密钥", messaging: "消息平台", setting: "设置", service: "服务" };
    return ["tool", "messaging", "setting", "service"]
      .map((cat) => ({
        category: cat,
        label: catLabels[cat] ?? cat,
        entries: Object.entries(envVars).filter(([, v]) => v.category === cat && !v.advanced),
      }))
      .filter((g) => g.entries.length > 0);
  }, [envVars]);

  const liveApiKey = providerForm.apiKey.trim() ||
    (typeof selectedProviderEntry.api_key === "string" ? selectedProviderEntry.api_key : "");
  const supportsModelListing = selectedProvider?.supportsModelListing !== false;
  const modelsQuery = useProviderModels(providerForm.baseUrl, liveApiKey || undefined);
  const liveModelIds = supportsModelListing ? modelsQuery.data?.models ?? [] : [];
  const mergedModelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const id of liveModelIds) set.add(id);
    if (selectedProvider) for (const m of selectedProvider.models) set.add(m.id);
    if (providerForm.model) set.add(providerForm.model);
    return Array.from(set);
  }, [liveModelIds, selectedProvider, providerForm.model]);

  const refreshLabel = modelsQuery.isFetching
    ? "刷新中…"
    : modelsQuery.isError
      ? "刷新失败 重试"
      : modelsQuery.data
        ? `已加载 ${modelsQuery.data.models.length} 个`
        : "刷新模型列表";

  const refreshErrorText = useMemo(() => {
    if (!supportsModelListing || !modelsQuery.isError) return "";
    const msg = modelsQuery.error instanceof Error ? modelsQuery.error.message : String(modelsQuery.error);
    if (/\b404\b|not found/i.test(msg)) return "此服务商未提供 /models 端点";
    if (/\b401\b|\b403\b|unauthor/i.test(msg)) return "API Key 无效或未保存";
    if (/Failed to fetch|NetworkError|TypeError|cors/i.test(msg)) {
      return "无法连接，可能被浏览器跨域策略拦截；桌面端可正常使用";
    }
    return msg;
  }, [supportsModelListing, modelsQuery.isError, modelsQuery.error]);

  useEffect(() => {
    if (!selectedProvider) return;
    const model = typeof selectedProviderEntry.model === "string"
      ? selectedProviderEntry.model
      : selectedProvider.defaultModel;
    const baseUrl = typeof selectedProviderEntry.base_url === "string"
      ? selectedProviderEntry.base_url
      : selectedProvider.baseUrl;
    setProviderForm({ apiKey: "", baseUrl, model });
    setSavedSnapshot({ baseUrl, model, providerId: selectedProvider.id });
  }, [
    selectedProvider,
    selectedProviderEntry.base_url,
    selectedProviderEntry.model,
  ]);

  // Switching to a different provider hides any stale "已保存" indicator.
  useEffect(() => {
    setSavedFlashFor(null);
    setProbeState(null);
    setProviderSaveError("");
  }, [selectedProvider?.id]);

  const handleProbe = useCallback(async () => {
    if (!selectedProvider) return;
    const apiKey = providerForm.apiKey.trim() ||
      (typeof selectedProviderEntry.api_key === "string" ? selectedProviderEntry.api_key : "");
    const baseUrl = providerForm.baseUrl.trim() || selectedProvider.baseUrl;
    setProbeState({ providerId: selectedProvider.id, status: "pending" });
    try {
      // Map catalog id → backend canonical slug for env-var fallback. When
      // the catalog id has no canonical equivalent (e.g. baidu-qianfan,
      // tencent-hunyuan — not in CANONICAL_PROVIDERS), we pass the catalog
      // id; the backend handler tolerates unknown slugs as long as api_key
      // + base_url are supplied explicitly.
      const result = await probeProvider({
        provider: selectedProvider.id,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        timeout_ms: 8000,
      });
      setProbeState({
        providerId: selectedProvider.id,
        status: result.ok ? "ok" : "error",
        result,
      });
    } catch (error) {
      setProbeState({
        providerId: selectedProvider.id,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [probeProvider, providerForm.apiKey, providerForm.baseUrl, selectedProvider, selectedProviderEntry.api_key]);

  const probeForSelected = probeState && selectedProvider && probeState.providerId === selectedProvider.id
    ? probeState
    : null;

  const isFormDirty = !!(
    selectedProvider &&
    (providerForm.apiKey.trim() !== "" ||
      providerForm.baseUrl !== (savedSnapshot?.baseUrl ?? "") ||
      providerForm.model !== (savedSnapshot?.model ?? ""))
  );
  const showSavedFlash = !isFormDirty && savedFlashFor === selectedProvider?.id;
  const selectedProviderModel = selectedProvider
    ? (providerForm.model.trim() || selectedProvider.defaultModel)
    : "";
  const selectedProviderIsCurrent = Boolean(
    selectedProvider &&
    selectedProviderModel &&
    currentProviderId === selectedProvider.id &&
    modelInfo?.model === selectedProviderModel,
  );

  // Deep-link from the picker's "去设置" CTA: /models#provider-<slug> selects
  // and scrolls to that provider so the user lands on the right key field.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    const match = hash.match(/^#provider-(.+)$/);
    if (!match) return;
    const targetId = decodeURIComponent(match[1]);
    if (!allProviders.some((p) => p.id === targetId)) return;
    setSelectedProviderId(targetId);
    // Wait one frame for the list item to mount with the new active state,
    // then scroll it into view with a soft highlight pulse.
    const handle = window.requestAnimationFrame(() => {
      const el = document.getElementById(`provider-${targetId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(handle);
    // intentionally only on mount + when catalog finishes loading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProviders.length]);

  const handleReveal = async (key: string) => {
    if (revealedValues[key]) {
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    const result = await revealEnv.mutateAsync(key);
    setRevealedValues((prev) => ({ ...prev, [key]: result.value }));
  };

  const handleSave = (key: string) => {
    setEnv.mutate({ key, value: editVal });
    setEditKey(null);
    setEditVal("");
  };

  const handleCatalogRefresh = () => {
    void refreshCatalog();
  };

  const handleProviderSave = async () => {
    if (!config || !selectedProvider) return;
    const pendingStartedAt = performance.now();
    const newApiKey = providerForm.apiKey.trim();
    const isCustomProvider = selectedProvider.id.startsWith("custom:");
    // Built-in providers (alibaba, deepseek, zai, kimi, ...): hermes-agent
    // only reads their API key from environment variables / ~/.hermes/.env,
    // never from config.yaml's providers.<id>.api_key. Mirror the key into
    // the named env var so chat requests actually find credentials. Custom
    // providers are read inline from config.yaml, so they don't need this.
    const savedBaseUrl = providerForm.baseUrl.trim() || selectedProvider.baseUrl;
    const savedModel = providerForm.model.trim() || selectedProvider.defaultModel;
    const providerId = selectedProvider.id;
    setProviderSavePending(true);
    setProviderSaveError("");
    try {
      if (newApiKey && !isCustomProvider && selectedProvider.apiKeyLabel) {
        await setEnv.mutateAsync({ key: selectedProvider.apiKeyLabel, value: newApiKey });
      }
      await saveConfig.mutateAsync(
        buildProviderSettingsUpdate(config, selectedProvider, providerForm),
      );
      setProviderForm((prev) => ({ ...prev, apiKey: "" }));
      setSavedSnapshot({
        baseUrl: savedBaseUrl,
        model: savedModel,
        providerId,
      });
      setSavedFlashFor(providerId);
    } catch (error) {
      setProviderSaveError(error instanceof Error ? error.message : String(error || "保存失败"));
    } finally {
      const elapsed = performance.now() - pendingStartedAt;
      if (elapsed < PROVIDER_ACTION_LOADING_MIN_MS) {
        await wait(PROVIDER_ACTION_LOADING_MIN_MS - elapsed);
      }
      setProviderSavePending(false);
    }
  };

  const handleSetCurrentModel = async () => {
    if (!config || !selectedProvider) return;
    const pendingStartedAt = performance.now();
    const savedModel = providerForm.model.trim() || selectedProvider.defaultModel;
    const providerId = selectedProvider.id;
    const providerName = selectedProvider.name;
    setProviderSetCurrentPending(true);
    setProviderSaveError("");
    try {
      // Same hot-switch path as the composer model picker: update the live
      // gateway runtime explicitly instead of only editing provider metadata.
      await setRuntimeModel(savedModel, providerId);
      await saveConfig.mutateAsync(
        buildCurrentModelConfigUpdate(config, selectedProvider, providerForm),
      );
      // PanelComposer / NewTaskRoute seed their model picker from localStorage.
      // This mirrors picking a model from the workbench composer, so the next
      // new session carries this explicit choice even before /api/model/info
      // finishes refetching.
      rememberLastUsedModel({
        model: savedModel,
        provider: providerId,
        providerName,
      });
    } catch (error) {
      setProviderSaveError(error instanceof Error ? error.message : String(error || "设置失败"));
    } finally {
      const elapsed = performance.now() - pendingStartedAt;
      if (elapsed < PROVIDER_ACTION_LOADING_MIN_MS) {
        await wait(PROVIDER_ACTION_LOADING_MIN_MS - elapsed);
      }
      setProviderSetCurrentPending(false);
    }
  };

  const handleAddCustom = () => {
    if (!config) return;
    const name = customForm.name.trim();
    const baseUrl = customForm.baseUrl.trim();
    const model = customForm.model.trim();
    const apiKey = customForm.apiKey.trim();
    if (!name || !baseUrl || !model) return;
    const host = baseUrl.match(/https?:\/\/([^/]+)/)?.[1] ?? "endpoint";
    const slug = host.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
    const existingIds = new Set(allProviders.map((p) => p.id));
    let candidate = `custom:${slug || "endpoint"}`;
    let suffix = 2;
    while (existingIds.has(candidate)) {
      candidate = `custom:${slug || "endpoint"}-${suffix++}`;
    }
    const preset: ProviderPreset = {
      id: candidate,
      name,
      vendor: "自定义",
      region: "cn",
      baseUrl,
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: model,
      models: [{ id: model, supportsTools: true }],
      isCustom: true,
    };
    saveConfig.mutate(
      buildProviderConfigUpdate(config, preset, { apiKey, baseUrl, model }),
      {
        onSuccess: () => {
          setSelectedProviderId(candidate);
          setShowCustomForm(false);
          setCustomForm({ name: "", baseUrl: "", apiKey: "", model: "" });
          setProviderForm({ apiKey: "", baseUrl, model });
        },
      },
    );
  };

  const envRowProps = (key: string, info: EnvVarInfo) => ({
    envKey: key,
    info,
    revealedValue: revealedValues[key],
    isEditing: editKey === key,
    editVal,
    onEdit: () => { setEditKey(key); setEditVal(""); },
    onEditChange: setEditVal,
    onSave: () => handleSave(key),
    onCancel: () => setEditKey(null),
    onReveal: () => handleReveal(key),
    onDelete: () => deleteEnv.mutate(key),
  });

  if (isLoading || configLoading) return <div className={s.desc}>加载中…</div>;
  if (!envVars || !config) return null;

  return (
    <div className={s.modelsSettings}>
      <div className={s.modelsSectionHeader}>
        <div>
          <p className={s.desc}>
            管理国内模型服务商预设和 API Key。
            {modelInfo && <> 当前模型: <b>{modelInfo.model}</b> ({modelInfo.provider})</>}
            {" · "}{configuredCount}/{catalog.providers.length} 个预设已配置
          </p>
        </div>
        <div className={s.catalogMeta}>
          <span>Provider Catalog {catalog.version}</span>
          {catalogMessage && <span className={s.catalogMessage}>{catalogMessage}</span>}
        </div>
      </div>

      <div className={s.providerPresetLayout}>
        <div className={s.providerPresetListPane}>
          <div className={s.providerListToolbar}>
            <input
              className={s.providerSearchInput}
              value={providerSearch}
              onChange={(event) => setProviderSearch(event.target.value)}
              placeholder="搜索模型平台..."
            />
            <button
              className={s.btn}
              onClick={() => setShowCustomForm(true)}
              title="添加自定义 OpenAI 兼容 provider"
            >
              + 自定义
            </button>
            <button className={s.btn} onClick={handleCatalogRefresh}>刷新预设</button>
          </div>
          <div className={s.providerPresetList}>
            {filteredProviders.map((provider) => {
              const configured = providerHasSavedCredentials(config, provider.id);
              const current = currentProviderId === provider.id;
              return (
                <button
                  key={provider.id}
                  id={`provider-${provider.id}`}
                  className={s.providerPresetItem}
                  data-active={selectedProvider?.id === provider.id}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <span className={s.providerPresetName}>{provider.name}</span>
                  <span className={s.providerPresetVendor}>{provider.vendor}</span>
                  <span className={s.providerPresetBadges}>
                    {current && <span className={s.statusBadge} data-on="true">当前</span>}
                    <span className={s.statusBadge} data-on={configured}>
                      {configured ? "已设置" : "未设置"}
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredProviders.length === 0 && (
              <div className={s.providerPresetEmpty}>没有匹配的模型平台</div>
            )}
          </div>
        </div>

        {selectedProvider && (
          <div className={s.providerPresetPanel}>
            <div className={s.providerPresetHeader}>
              <div>
                <div className={s.providerDetailName}>{selectedProvider.name}</div>
                <div className={s.providerDetailVendor}>
                  {selectedProvider.id} · {selectedProvider.vendor}
                  {selectedProvider.docsUrl && <> · <a href={selectedProvider.docsUrl} target="_blank" rel="noreferrer" className={s.link}>文档 ↗</a></>}
                </div>
              </div>
              <span className={s.statusBadge} data-on={selectedHasCredentials}>
                {selectedHasCredentials ? "已保存密钥" : "未设置"}
              </span>
            </div>

            <div className={s.providerFormGrid}>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>{selectedProvider.apiKeyLabel}</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  type="password"
                  value={providerForm.apiKey}
                  placeholder={selectedHasCredentials ? "已保存" : "粘贴 API Key"}
                  onChange={(event) => setProviderForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>Base URL</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  value={providerForm.baseUrl}
                  onChange={(event) => setProviderForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>模型</div>
                <div className={s.modelPickerRow}>
                  <ModelCombobox
                    value={providerForm.model}
                    onChange={(next) => setProviderForm((prev) => ({ ...prev, model: next }))}
                    options={mergedModelOptions}
                  />
                  {supportsModelListing ? (
                    <button
                      type="button"
                      className={s.btn}
                      disabled={modelsQuery.isFetching}
                      onClick={() => modelsQuery.refetch()}
                      title={`从 ${providerForm.baseUrl}/models 拉取`}
                    >
                      {refreshLabel}
                    </button>
                  ) : null}
                </div>
              </label>
              {!supportsModelListing && (
                <div className={s.modelPickerHint}>此服务商不提供 /models 端点，使用预设模型或手动输入即可</div>
              )}
              {refreshErrorText && (
                <div className={s.modelPickerError}>{refreshErrorText}</div>
              )}
            </div>

            <div className={s.modelTags}>
              {mergedModelOptions.slice(0, 8).map((id) => (
                <span key={id} className={s.modelTag}>{id}</span>
              ))}
            </div>

            <div className={s.providerActions}>
              <button
                className={s.btnPrimary}
                disabled={
                  providerSavePending ||
                  providerSetCurrentPending ||
                  !isFormDirty ||
                  (!selectedHasCredentials && !providerForm.apiKey.trim())
                }
                onClick={() => void handleProviderSave()}
              >
                {providerSavePending
                  ? (
                    <>
                      <span className={s.buttonSpinner} aria-hidden="true" />
                      保存中…
                    </>
                  )
                  : showSavedFlash
                    ? "✓ 已保存"
                    : "保存配置"}
              </button>
              <button
                className={isFormDirty || selectedProviderIsCurrent ? s.btn : s.btnPrimary}
                disabled={
                  selectedProviderIsCurrent ||
                  providerSavePending ||
                  providerSetCurrentPending ||
                  !selectedProviderModel ||
                  !selectedHasCredentials
                }
                onClick={() => void handleSetCurrentModel()}
                title={
                  selectedProviderIsCurrent
                    ? "当前已在使用这个模型"
                    : selectedHasCredentials
                      ? "切换当前运行模型；如刚修改了 Base URL / API Key，请先保存配置"
                      : "请先保存 API Key / provider 配置"
                }
              >
                {providerSetCurrentPending
                  ? (
                    <>
                      <span className={s.buttonSpinner} aria-hidden="true" />
                      切换中…
                    </>
                  )
                  : selectedProviderIsCurrent
                    ? "已是当前模型"
                    : "设为当前模型"}
              </button>
              <button
                className={s.btn}
                disabled={
                  probeForSelected?.status === "pending" ||
                  (!selectedHasCredentials && !providerForm.apiKey.trim())
                }
                onClick={() => void handleProbe()}
                title="向 /models 端点发一次 GET，验证 API Key + 网络通"
              >
                {probeForSelected?.status === "pending" ? "测试中…" : "测试连接"}
              </button>
            </div>
            {probeForSelected && probeForSelected.status !== "pending" && (
              <ProbeResultRow probe={probeForSelected} />
            )}
            {providerSaveError && (
              <div className={s.modelPickerError} style={{ marginTop: 8 }}>
                操作失败：{providerSaveError}
              </div>
            )}
          </div>
        )}
      </div>

      <OAuthProvidersSection />

      <div className={s.advancedEnvBlock}>
        <button className={s.providerCardHeader} onClick={() => setShowEnvAdvanced((prev) => !prev)}>
          <span className={s.providerCardName}>
            <span className={s.providerCardArrow}>{showEnvAdvanced ? "▾" : "▸"}</span>
            高级环境变量
          </span>
          <span className={s.providerCardCount}>{providerEnvEntries.length} 项</span>
        </button>
        {showEnvAdvanced && (
          <div className={s.providerCardBody}>
            {providerEnvEntries.map(([key, info]) => (
              <EnvRow key={key} {...envRowProps(key, info)} />
            ))}
          </div>
        )}
      </div>

      {nonProviderGroups.map((group) => (
        <div key={group.category} style={{ marginTop: 24 }}>
          <div className={s.modelsLabel}>{group.label} ({group.entries.length})</div>
          {group.entries.map(([key, info]) => (
            <EnvRow key={key} {...envRowProps(key, info)} />
          ))}
        </div>
      ))}

      {showCustomForm && createPortal(
        <div className={s.customProviderBackdrop} onClick={closeCustomForm}>
          <div
            className={s.customProviderModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby={customDialogTitleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={s.customProviderTitleBar}>
              <h2 id={customDialogTitleId}>添加自定义 Provider</h2>
              <button
                type="button"
                className={s.customProviderClose}
                onClick={closeCustomForm}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className={s.customProviderBody}>
              <p className={s.customProviderHint}>
                添加任意 OpenAI Chat Completions 兼容服务（百度千帆 / 腾讯混元 / SiliconFlow / 私有部署等）。提交后可在左侧列表里随时切换。
              </p>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>名称</div>
                <input
                  className={s.fieldInput}
                  value={customForm.name}
                  placeholder="例如：腾讯混元"
                  autoFocus
                  onChange={(e) => setCustomForm((p) => ({ ...p, name: e.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>Base URL</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  value={customForm.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setCustomForm((p) => ({ ...p, baseUrl: e.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>默认模型</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  value={customForm.model}
                  placeholder="hunyuan-turbos-latest"
                  onChange={(e) => setCustomForm((p) => ({ ...p, model: e.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>API Key</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  type="password"
                  value={customForm.apiKey}
                  placeholder="可选，先建后填也行"
                  onChange={(e) => setCustomForm((p) => ({ ...p, apiKey: e.target.value }))}
                />
              </label>
            </div>
            <div className={s.customProviderActions}>
              <button type="button" className={s.btn} onClick={closeCustomForm}>取消</button>
              <button
                type="button"
                className={s.btnPrimary}
                disabled={
                  saveConfig.isPending ||
                  !customForm.name.trim() ||
                  !customForm.baseUrl.trim() ||
                  !customForm.model.trim()
                }
                onClick={handleAddCustom}
              >
                {saveConfig.isPending ? "保存中…" : "添加并选中"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function EnvRow({ envKey, info, revealedValue, isEditing, editVal, onEdit, onEditChange, onSave, onCancel, onReveal, onDelete }: {
  envKey: string; info: EnvVarInfo; revealedValue?: string; isEditing: boolean; editVal: string;
  onEdit: () => void; onEditChange: (v: string) => void; onSave: () => void; onCancel: () => void; onReveal: () => void; onDelete: () => void;
}) {
  return (
    <div className={s.row}>
      <div className={s.rowLeft}>
        <div className={s.rowLabel}>{envKey}</div>
        <div className={s.rowSub}>
          {info.description}
          {info.url && <> · <a href={info.url} target="_blank" rel="noreferrer" className={s.link}>获取 Key ↗</a></>}
          {info.tools.length > 0 && ` · 用于: ${info.tools.join(", ")}`}
        </div>
      </div>
      <div className={s.rowRight} style={{ gap: 6, flexWrap: "wrap", minWidth: 200 }}>
        {isEditing ? (
          <>
            <input className={s.input} data-mono type={info.is_password ? "password" : "text"} value={editVal} onChange={(e) => onEditChange(e.target.value)} placeholder="输入值…" style={{ width: 180 }} autoFocus />
            <button className={s.btnPrimary} onClick={onSave}>保存</button>
            <button className={s.btn} onClick={onCancel}>取消</button>
          </>
        ) : (
          <>
            <span className={`${s.statusBadge} ${s.envStatusBadge}`} data-on={info.is_set}>
              {info.is_set ? (revealedValue ?? info.redacted_value ?? "已设置") : "未设置"}
            </span>
            <button className={s.btn} onClick={onEdit}>{info.is_set ? "替换" : "设置"}</button>
            {info.is_set && info.is_password && (
              <button className={s.btn} onClick={onReveal}>{revealedValue ? "隐藏" : "查看"}</button>
            )}
            {info.is_set && <button className={s.btnDanger} onClick={onDelete}>删除</button>}
          </>
        )}
      </div>
    </div>
  );
}

function ProbeResultRow({ probe }: { probe: { status: "ok" | "error" | "pending"; result?: ProviderProbeResult; message?: string } }) {
  if (probe.status === "pending") return null;
  const result = probe.result;
  if (probe.status === "ok" && result?.ok) {
    return (
      <div className={s.desc} style={{ marginTop: 8 }}>
        ✓ 连接成功 · 延迟 {result.latency_ms}ms · 可用 {result.model_count} 个模型
        {result.sample_models.length > 0 && (
          <span style={{ marginLeft: 8, opacity: 0.7 }}>
            （示例：{result.sample_models.slice(0, 3).join("、")}）
          </span>
        )}
      </div>
    );
  }
  const errorText = result?.error || probe.message || "未知错误";
  const kindLabel: Record<string, string> = {
    auth: "API Key 被拒绝",
    timeout: "请求超时",
    http: "HTTP 错误",
    network: "网络不通",
    unknown: "未知错误",
  };
  const kind = result?.error_kind ? kindLabel[result.error_kind] ?? result.error_kind : "请求失败";
  return (
    <div className={s.desc} style={{ marginTop: 8, color: "var(--h-danger, #c44)" }}>
      ✗ {kind} · {errorText}
    </div>
  );
}
