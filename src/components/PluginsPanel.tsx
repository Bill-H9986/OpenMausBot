import { useEffect, useRef, useState } from "react";
import { Check, Copy, Search, Server, X } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { McpServersPanel } from "./McpServersPanel";
export { ServiceIcon, type ToolkitCard } from "./ServiceIcon";

interface DomesticPlugin {
  id: "feishu" | "amap" | "wecom" | "localdb";
  nameKey: LocaleKey;
  descKey: LocaleKey;
  glyph: string;
  color: string;
  template: string;
}

/** The four connectors this build ships UI for: the card shows now, the live wiring follows. */
const DOMESTIC_PLUGINS: DomesticPlugin[] = [
  {
    id: "feishu",
    nameKey: "apps.plugins.feishu.name",
    descKey: "apps.plugins.feishu.desc",
    glyph: "飞",
    color: "#3370ff",
    template: JSON.stringify({
      provider: "feishu",
      app_id: "cli_xxx",
      app_secret: "xxx",
      encrypt_key: "",
      verification_token: "",
    }, null, 2),
  },
  {
    id: "amap",
    nameKey: "apps.plugins.amap.name",
    descKey: "apps.plugins.amap.desc",
    glyph: "高",
    color: "#2e7d32",
    template: JSON.stringify({
      provider: "amap",
      key: "your_amap_web_key",
      securityJsCode: "optional",
    }, null, 2),
  },
  {
    id: "wecom",
    nameKey: "apps.plugins.wecom.name",
    descKey: "apps.plugins.wecom.desc",
    glyph: "企",
    color: "#07c160",
    template: JSON.stringify({
      provider: "wecom",
      corp_id: "ww_xxx",
      agent_id: 1000002,
      secret: "xxx",
    }, null, 2),
  },
  {
    id: "localdb",
    nameKey: "apps.plugins.localdb.name",
    descKey: "apps.plugins.localdb.desc",
    glyph: "库",
    color: "#475569",
    template: JSON.stringify({
      provider: "local-db",
      dialect: "mysql",
      host: "127.0.0.1",
      port: 3306,
      database: "app",
      user: "bot_ro",
    }, null, 2),
  },
];

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const surface = state.pluginsSurface;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [appsOnly, setAppsOnly] = useState(false);
  const [open, setOpen] = useState<DomesticPlugin["id"] | null>(null);
  const [copied, setCopied] = useState(false);
  const filter: "all" | "apps" | "mcp" = surface === "mcp" ? "mcp" : appsOnly ? "apps" : "all";

  const close = () => dispatch({ type: "togglePlugins", open: false });

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);

    const controls = focusable();
    (controls.find((element) => element.matches("input")) ?? controls[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (!items.some((element) => element === document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [dispatch]);

  const chooseFilter = (next: "all" | "apps" | "mcp") => {
    if (next === "mcp") {
      setAppsOnly(false);
      dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
      return;
    }
    if (surface === "mcp") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
    setAppsOnly(next === "apps");
  };

  const query = search.toLowerCase().trim();
  const shown = DOMESTIC_PLUGINS.filter((plugin) =>
    !query || (t(plugin.nameKey) + " " + t(plugin.descKey) + " " + plugin.id).toLowerCase().includes(query));

  const copy = async (template: string) => {
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const pill = "inline-flex h-7 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[13px] font-medium leading-5 transition-colors";
  const pillTone = (selected: boolean) => selected
    ? "bg-ink text-app"
    : "bg-control/70 text-ink-secondary hover:bg-raised-hover hover:text-ink";

  const domestic = filter === "all" || filter === "apps" ? (
    <div data-apps-grid className="@container flex flex-col gap-7 pt-1">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-ink">{t("apps.plugins.title")}</h3>
          <span className="text-[12px] text-ink-secondary">{t("apps.plugins.comingSoon")}</span>
        </div>
        <p className="text-[13px] leading-5 text-ink-secondary">{t("apps.plugins.hint")}</p>
        {shown.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center text-[13px] text-ink-secondary">{t("connectors.noAppsFound")}</div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2">
            {shown.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                data-app-tile={plugin.id}
                aria-expanded={open === plugin.id}
                onClick={() => setOpen(open === plugin.id ? null : plugin.id)}
                className="flex min-w-0 flex-col rounded-xl bg-card p-4 text-start transition-colors hover:bg-raised/40"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-[15px] font-semibold text-white"
                    style={{ backgroundColor: plugin.color }}
                    aria-hidden="true"
                  >
                    {plugin.glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold leading-5 text-ink">{t(plugin.nameKey)}</span>
                      <span className="shrink-0 rounded-full bg-control/80 px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-secondary">
                        {t("apps.plugins.comingSoon")}
                      </span>
                    </div>
                    <div className="truncate text-[13px] leading-[18px] text-ink-secondary" title={t(plugin.descKey)}>
                      {t(plugin.descKey)}
                    </div>
                  </div>
                </div>
                {open === plugin.id && (
                  <div className="mt-3 w-full">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[12px] font-medium text-ink-secondary">{t("apps.plugins.template")}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => { event.stopPropagation(); void copy(plugin.template); }}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); void copy(plugin.template); } }}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-raised-hover"
                      >
                        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                        {copied ? t("apps.plugins.copied") : t("apps.plugins.copy")}
                      </span>
                    </div>
                    <pre className="max-h-44 overflow-auto rounded-lg bg-inset p-3 text-[12px] leading-[17px] text-ink">{plugin.template}</pre>
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  ) : null;

  const mcp = filter === "all" || filter === "mcp" ? (
    <div className={cn(filter === "all" && "mt-8 border-t border-hairline/30 pt-6", filter === "mcp" && "pt-1")}>
      <McpServersPanel embedded />
    </div>
  ) : null;

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        data-tour="apps-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex max-w-[780px] flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex flex-col gap-4 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div>
            <div className="flex items-center justify-between gap-3">
              <h2 id="plugins-title" className="min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
              <button
                data-tour="apps-close"
                onClick={close}
                aria-label={t("connectors.closeAria")}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("apps.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-control/70 px-3.5 focus-within:ring-1 focus-within:ring-accent">
              <Search size={15} className="shrink-0 text-ink-secondary" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("connectors.searchPlaceholder")}
                aria-label={t("connectors.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </label>
            <button
              type="button"
              data-apps-filter="mcp"
              aria-pressed={filter === "mcp"}
              onClick={() => chooseFilter(filter === "mcp" ? "all" : "mcp")}
              className={cn(pill, "h-9 border border-hairline/40 px-3.5", filter === "mcp" ? "bg-ink text-app" : "text-ink hover:bg-raised")}
            >
              <Server size={14} aria-hidden="true" />
              <span className="hidden sm:inline">{t("apps.filter.mcp")}</span>
              <span className="sr-only sm:hidden">{t("apps.filter.mcp")}</span>
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("apps.filter.aria")}>
            <button
              type="button"
              data-apps-filter="all"
              aria-pressed={filter === "all"}
              onClick={() => chooseFilter("all")}
              className={cn(pill, pillTone(filter === "all"))}
            >
              {t("apps.filter.all")}
            </button>
            <button
              type="button"
              data-apps-filter="apps"
              aria-pressed={filter === "apps"}
              onClick={() => chooseFilter("apps")}
              className={cn(pill, pillTone(filter === "apps"))}
            >
              {t("apps.plugins.title")}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-7 sm:px-7">
          {domestic}
          {mcp}
        </div>
      </div>
    </div>
  );
}