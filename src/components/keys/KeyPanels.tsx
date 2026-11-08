import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { KEY_FIELD, MaskedKey } from "./KeyRow";



/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);
  const clearing = !alias.trim() && configured;

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ vps: { sshAlias: alias.trim() } }) })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/byo-vps.md" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-key-input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label={t("keys.vps.aria")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,12rem)] flex-1")}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || (!alias.trim() && !configured) || alias.trim() === (state.config?.vps?.sshAlias ?? "")}
          className={cn("ui-button shrink-0", !clearing && "ui-button-primary")}
          title={clearing ? t("keys.vps.removeAlias") : undefined}
        >
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : clearing ? t("keys.row.remove") : t("common.save")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function OpenAiCompatUrl() {
  const { state, dispatch } = useStore();
  const saved = state.config?.openaiCompat?.url ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  useEffect(() => { setValue(saved); }, [saved]);
  const dirty = value.trim() !== saved;

  const save = () => {
    if (savingRef.current || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ openaiCompat: { url: value.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[13px] leading-[18px] text-ink">{t("keys.openaiCompat.url")}</div>
      <div className="relative">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="https://api.groq.com/openai/v1"
          aria-label={t("keys.openaiCompat.url")}
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-8")}
        />
        {saving && <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />}
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.openaiCompat.urlHint")}</p>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function DeepSeekEndpoint() {
  const { state, dispatch } = useStore();
  const saved = state.config?.deepseek?.baseUrl ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  useEffect(() => { setValue(saved); }, [saved]);
  const dirty = value.trim() !== saved;

  const save = () => {
    if (savingRef.current || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ deepseek: { baseUrl: value.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[13px] leading-[18px] text-ink">{t("keys.deepseek.baseUrl")}</div>
      <div className="relative">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="https://api.deepseek.com/anthropic"
          aria-label={t("keys.deepseek.baseUrl")}
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-8")}
        />
        {saving && <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />}
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.deepseek.baseUrlHint")}</p>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function CustomOpenAiCompatEndpoint() {
  const { state, dispatch } = useStore();
  const saved = state.config?.customOpenAI;
  const [url, setUrl] = useState(saved?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [models, setModels] = useState((saved?.models ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    setUrl(saved?.baseUrl ?? "");
    setModels((saved?.models ?? []).join(", "));
  }, [saved?.baseUrl, saved?.models]);

  const put = (patch: Record<string, unknown>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ customOpenAI: patch }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  const saveUrl = () => {
    const value = url.trim();
    if (value === (saved?.baseUrl ?? "")) return;
    put({ baseUrl: value });
  };
  const saveKey = () => {
    if (!key.trim()) return;
    put({ apiKey: key.trim() });
    setKey("");
  };

  const saveModels = () => {
    const list = models.split(",").map((part) => part.trim()).filter(Boolean);
    if (JSON.stringify(list) === JSON.stringify(saved?.models ?? [])) return;
    put({ models: list });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] leading-[18px] text-ink">{t("keys.customOpenAI.baseUrl")}</div>
        <div className="relative">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={saveUrl}
            onKeyDown={(e) => e.key === "Enter" && saveUrl()}
            placeholder="https://open.bigmodel.cn/api/paas/v4"
            aria-label={t("keys.customOpenAI.baseUrl")}
            spellCheck={false}
            className={cn(KEY_FIELD, "pr-8")}
          />
          {saving && <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />}
        </div>
        <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.customOpenAI.baseUrlHint")}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] leading-[18px] text-ink">{t("keys.customOpenAI.apiKey")}</div>
        <div className="flex items-center gap-2">
          {saved?.configured && key === "" && <MaskedKey saved={saved} label={t("keys.customOpenAI.apiKey")} />}
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={saveKey}
            onKeyDown={(e) => e.key === "Enter" && saveKey()}
            placeholder={saved?.configured ? "replace the saved key" : "sk-..."}
            aria-label={t("keys.customOpenAI.apiKey")}
            spellCheck={false}
            className={cn(KEY_FIELD, "flex-1")}
          />
          <button
            type="button"
            onClick={saveKey}
            disabled={saving || !key.trim()}
            className="ui-button shrink-0"
          >
            {t("common.save")}
          </button>
          {saved?.configured && (
            <button
              type="button"
              onClick={() => put({ apiKey: "" })}
              className="ui-button shrink-0"
            >
              {t("keys.row.remove")}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] leading-[18px] text-ink">{t("keys.customOpenAI.models")}</div>
        <input
          type="text"
          value={models}
          onChange={(e) => setModels(e.target.value)}
          onBlur={saveModels}
          onKeyDown={(e) => e.key === "Enter" && saveModels()}
          placeholder="glm-4-flash, glm-4"
          aria-label={t("keys.customOpenAI.models")}
          spellCheck={false}
          className={cn(KEY_FIELD)}
        />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.customOpenAI.modelsHint")}</p>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
