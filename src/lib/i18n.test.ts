import { afterEach, describe, expect, it, vi } from "vitest";

import { applyBrand, DEFAULT_BRAND } from "./brand";
import { documentLanguage, resolveLocale, setLocale, t, tFromServer } from "./i18n";
import { en, loadLocalePack, localeChoices, locales } from "@/locales";

afterEach(() => {
  setLocale("en");
});

describe("resolveLocale", () => {
  const available = new Set(["en", "de", "pt-br", "zh", "zh-hant", "zh-tw"]);

  it("keeps a registered exact tag, case-insensitively", () => {
    expect(resolveLocale("pt-BR", available)).toBe("pt-br");
    expect(resolveLocale("de", available)).toBe("de");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(resolveLocale("de-AT", available)).toBe("de");
  });

  it("falls back through script tags before the base language", () => {
    expect(resolveLocale("zh-Hant-TW", available)).toBe("zh-hant");
  });

  it("falls back to English for unknown or missing tags", () => {
    expect(resolveLocale("fr-FR", available)).toBe("en");
    expect(resolveLocale(undefined, available)).toBe("en");
    expect(resolveLocale("", available)).toBe("en");
  });
});

describe("t", () => {
  it("returns the English catalog value by default", () => {
    expect(t("engines.cloud")).toBe("Cloud");
  });

  it("fills {app} with the product's name, a white-label brand's own name, or the name a caller passes", () => {
    expect(t("routines.runsOn.localHint")).toBe("Starts while Jarvis Bot is open here.");
    expect(t("routines.runsOn.localHint", { app: "Acme" })).toBe("Starts while Acme is open here.");
    applyBrand({ brand: { name: "Acme Bots" }, source: "file", file: "/brand.json" });
    try {
      expect(t("routines.runsOn.localHint")).toBe("Starts while Acme Bots is open here.");
    } finally {
      applyBrand({ brand: DEFAULT_BRAND, source: "default", file: "" });
    }
  });

  it("keeps new department lifecycle labels available in partial packs, with interpolated names and counts", () => {
    setLocale("en");
    expect(t("team.create")).toBe("Create department");
    expect(t("team.moveTo", { name: "Research" })).toBe("Move bots to Research");
    expect(t("team.moveMany", { count: 2 })).toBe("Move 2 bots");
    expect(t("team.deleteTitle", { name: "Research" })).toBe("Delete Research department?");
    expect(t("team.instructionsTitle", { name: "Research" })).toBe("Research shared instructions");
  });

  it("setLocale reports the locale that actually took effect", async () => {
    await loadLocalePack("zh");
    expect(setLocale("zh-TW")).toBe("zh-tw");
    expect(t("engines.local")).toBe("本地");
    expect(setLocale("xx-YY")).toBe("en");
    expect(t("engines.local")).toBe("Local");
  });

  it("resolves every registered locale to itself", () => {
    const available = new Set(Object.keys(locales));
    for (const code of available) {
      expect(resolveLocale(code, available)).toBe(code);
    }
  });

  it("routes common system tags onto the shipped packs", async () => {
    await loadLocalePack("zh");
    const available = new Set(Object.keys(locales));
    expect(resolveLocale("en", available)).toBe("en");
    expect(resolveLocale("zh-CN", available)).toBe("zh");
    expect(resolveLocale("zh-TW", available)).toBe("zh-tw");
    expect(resolveLocale("zh-Hant-TW", available)).toBe("zh-hant");
    expect(resolveLocale("fr-FR", available)).toBe("en");
    expect(resolveLocale("xx-YY", available)).toBe("en");
  });

  it("every registered pack carries only known keys with non-empty values", () => {
    for (const pack of Object.values(locales)) {
      for (const [key, value] of Object.entries(pack)) {
        expect(Object.hasOwn(en, key)).toBe(true);
        expect((value ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("ships translated model and trusted-access help for threads", () => {
    for (const [code, pack] of Object.entries(locales)) {
      if (code === "en") continue;
      for (const key of ["model.threadBusy", "model.chooseThreadHint", "approvalMode.threadTrustedNotice"] as const) {
        expect(pack[key], `${code}: ${key}`).toBeTruthy();
        expect(pack[key], `${code}: ${key}`).not.toBe(en[key]);
      }
    }
  });

  it("ships exactly one JSON catalog for every picker language", () => {
    const files = Object.keys(import.meta.glob("../locales/*.json", { eager: true }))
      .map((path) => path.split("/").at(-1))
      .filter((file) => file !== "source-hashes.json")
      .sort();
    const choices = localeChoices.map(({ code }) => `${code}.json`).sort();
    expect(files).toEqual(choices);
  });

  it("overlays a partial pack and falls back to English for missing keys", () => {
    locales["zz"] = { "engines.cloud": "Wolke" };
    try {
      expect(setLocale("zz")).toBe("zz");
      expect(t("engines.cloud")).toBe("Wolke");
      expect(t("engines.local")).toBe("Local");
    } finally {
      delete locales["zz"];
      setLocale("en");
    }
  });

  it("interpolates params and keeps unmatched placeholders visible", () => {
    // A raw template, so the test doesn't depend on which catalog keys use params.
    const template = "Hello {name}, {missing}!";
    const rendered = template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in { name: "Maus" } ? String({ name: "Maus" }[name as "name"]) : match,
    );
    expect(rendered).toBe("Hello Maus, {missing}!");
  });
});

describe("tFromServer", () => {
  it("translates a key the catalog knows", () => {
    locales["zz"] = { "approval.held.native": "Der Anbieter verlangt deine Zustimmung." };
    try {
      setLocale("zz");
      expect(tFromServer("approval.held.native", "The provider requires your approval for this action."))
        .toBe("Der Anbieter verlangt deine Zustimmung.");
    } finally {
      delete locales["zz"];
      setLocale("en");
    }
  });

  it("falls back to English for a key this build does not carry", () => {
    expect(tFromServer("approval.held.inventedLater", "A note from a newer server."))
      .toBe("A note from a newer server.");
  });

  it.each(["constructor", "toString", "__proto__"])("rejects inherited catalog property %s", (key) => {
    expect(tFromServer(key, "A note from the server.")).toBe("A note from the server.");
  });

  it("shows a card that carries only text, and nothing when it carries neither", () => {
    expect(tFromServer(undefined, "Routine could not be applied: disk full"))
      .toBe("Routine could not be applied: disk full");
    expect(tFromServer(undefined, undefined)).toBeUndefined();
  });

  it("prefers the catalog over stale text saved with an older card", () => {
    expect(tFromServer("approval.held.undelivered", "Auto mode couldn't answer this one."))
      .toBe(en["approval.held.undelivered"]);
  });
});

describe("loading a language", () => {
  afterEach(() => {
    vi.doUnmock("@/locales");
    vi.resetModules();
  });

  it("starts with English alone and shows another language only once its pack is here", async () => {
    vi.resetModules();
    const page = await import("./i18n");
    const packs = await import("@/locales");
    expect(Object.keys(packs.locales)).toEqual(["en"]);
    expect(page.setLocale("en")).toBe("en");
    expect(page.t("engines.local")).toBe("Local");
    expect(await page.loadLocale("zh-TW")).toBe("zh-tw");
    expect(page.t("engines.local")).toBe("本地");
    expect(packs.locales["zh"]).toBe(packs.locales["zh-tw"]);
    expect(page.setLocale("en")).toBe("en");
  });

  it("shows the language asked for last, whichever pack arrives first", async () => {
    vi.resetModules();
    const page = await import("./i18n");
    expect(await page.loadLocale("zh")).toBe("zh");
    expect(page.activeLocale()).toBe("zh");
    expect(await page.loadLocale("en")).toBe("en");
    expect(page.activeLocale()).toBe("en");
  });

  it("falls back to English when a pack can't be loaded, and tries again next time", async () => {
    vi.resetModules();
    let offline = true;
    vi.doMock("@/locales", async (original) => {
      const real = await original<typeof import("@/locales")>();
      return { ...real, loadLocalePack: (tag: string) => offline ? Promise.reject(new Error("offline")) : real.loadLocalePack(tag) };
    });
    const page = await import("./i18n");
    expect(await page.loadLocale("zh")).toBe("en");
    expect(page.t("rail.thisComputer")).toBe("This computer");
    offline = false;
    expect(await page.loadLocale("zh")).toBe("zh");
    expect(page.t("rail.thisComputer")).toBe("这台电脑");
  });
});

describe("page language", () => {
  afterEach(() => {
    setLocale("en");
    vi.unstubAllGlobals();
  });

  it("names every picker language with a valid BCP-47 tag", () => {
    expect(localeChoices.map(({ code }) => documentLanguage(code))).toEqual(["en", "zh"]);
    for (const { code } of localeChoices) {
      expect(Intl.getCanonicalLocales(documentLanguage(code))).toEqual([documentLanguage(code)]);
    }
  });

  it("tags an alias with the pack it shows", () => {
    expect(documentLanguage("zh")).toBe("zh");
    expect(documentLanguage("zh-hant")).toBe("zh");
    expect(documentLanguage("zh-hk")).toBe("zh");
  });

  it("sets the page language and direction whenever the locale changes", async () => {
    const root = { lang: "en", dir: "" };
    vi.stubGlobal("document", { documentElement: root });
    await loadLocalePack("zh");
    setLocale("zh");
    expect(root).toEqual({ lang: "zh", dir: "ltr" });
    setLocale("en");
    expect(root.lang).toBe("en");
    setLocale("xx-YY");
    expect(root.lang).toBe("en");
  });

  it("tags the page once the language's pack has loaded, keeping the one it shows until then", async () => {
    const root = { lang: "en", dir: "" };
    vi.stubGlobal("document", { documentElement: root });
    vi.resetModules();
    const page = await import("./i18n");
    await page.loadLocale("zh");
    expect(root.lang).toBe("zh");
    expect(page.t("engines.local")).toBe("本地");
    expect(page.setLocale("en")).toBe("en");
    expect(root.lang).toBe("en");
  });

  it("still switches language where there is no page (tests, workers)", () => {
    vi.stubGlobal("document", undefined);
    expect(setLocale("en")).toBe("en");
    expect(t("engines.local")).not.toBe("");
  });
});
