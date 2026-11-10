import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { locales } from "@/locales";
import { rowsBody, secretRow } from "./mcp-draft";
import { ConnectorCard } from "./ConnectorCard";
import { McpServersPanel } from "./McpServersPanel";
import { PluginsPanel } from "./PluginsPanel";

vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: null, bots: [], instances: [], pluginsSurface: "apps" }, dispatch: vi.fn() }),
}));

afterEach(() => {
  setLocale("en");
});

describe("plugins modal translation", () => {
  it("translates the panel header and its MCP section in every loaded pack", () => {
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      const html = renderToStaticMarkup(createElement(() => PluginsPanel()));
      expect(html, code).toContain(pack["apps.title"]);
      expect(html, code).toContain(pack["apps.subtitle"]);
      expect(html, code).toContain(pack["mcp.title"]);
    }
  });

  it("translates the MCP panel headings in every loaded pack", () => {
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      const html = renderToStaticMarkup(createElement(() => McpServersPanel()));
      expect(html, code).toContain(pack["mcp.title"]);
      expect(html, code).toContain(pack["mcp.subtitle"]);
      expect(html, code).toContain(pack["mcp.trustNotice"]);
    }
  });

  it("translates an MCP environment parse error without touching the offending line", () => {
    setLocale("zh");
    expect(rowsBody([secretRow({ name: "NOT A KEY", value: "value" })], "env")).toEqual({
      ok: false,
      error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } },
    });
  });

  it("translates the in-chat connector card", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(createElement(ConnectorCard, {
      botId: "atlas",
      threadId: "thread",
      message: {
        id: "m1",
        role: "bot",
        kind: "connector",
        at: 1,
        connector: { slug: "feishu", label: "飞书", description: "Messages", status: "required", resumeKey: "resume1" },
      },
    }));
    expect(html).toContain(locales.zh!["connectors.card.connectSecurely"]);
    expect(html).toContain(locales.zh!["connectors.card.requested"]);
  });
});
