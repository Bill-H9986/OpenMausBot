import en from "./en.json";

export { en };
export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;

const packLoaders = {
  zh: () => import("./zh.json"),
} satisfies Record<string, () => Promise<{ default: LocalePack }>>;

export type PackName = "en" | keyof typeof packLoaders;

/** Every language tag the app answers to, and the pack it shows. */
export const localePacks: Readonly<Record<string, PackName>> = {
  en: "en",
  zh: "zh",
  "zh-hant": "zh",
  "zh-hk": "zh",
  "zh-mo": "zh",
  "zh-tw": "zh",
};

/** The packs this page has loaded, under every tag that shows them: English, and each one loadLocalePack fetched. */
export const locales: Record<string, LocalePack> = { en };

export async function loadLocalePack(tag: string): Promise<LocalePack | undefined> {
  const name = localePacks[tag];
  if (locales[tag] || !name || name === "en") return locales[tag];
  const pack: LocalePack = (await packLoaders[name]()).default;
  for (const [alias, shown] of Object.entries(localePacks)) if (shown === name) locales[alias] ??= pack;
  return pack;
}

export const localeChoices: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh", label: "简体中文" },
];
