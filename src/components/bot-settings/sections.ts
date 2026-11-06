import {
  BookOpen,
  Brain,
  CalendarClock,
  Cpu,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Sparkles,
  User,
} from "lucide-react";

import type { BotSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";

export const BOT_SECTIONS: Array<{
  id: BotSettingsSection;
  label: string;
  labelKey?: LocaleKey;
  icon: LucideIcon;
  keywords: string[];
}> = [
  { id: "overview", label: "Overview", labelKey: "botSettings.sections.overview", icon: LayoutDashboard, keywords: ["summary", "status", "what it does", "won't", "prompt", "what the model sees"] },
  { id: "identity", label: "Identity", labelKey: "botSettings.sections.identity", icon: User, keywords: ["name", "title", "avatar", "blurb", "instructions"] },
  { id: "soul", label: "Soul", labelKey: "botSettings.sections.soul", icon: Sparkles, keywords: ["standing instructions", "instructions", "persona", "rules", "soul.md"] },
  { id: "skills", label: "Skills", labelKey: "botSettings.sections.skills", icon: BookOpen, keywords: ["skills", "learned", "procedures", "teach"] },
  { id: "memory", label: "Memory", labelKey: "botSettings.sections.memory", icon: Brain, keywords: ["memory", "notes", "remember", "topics"] },
  { id: "routines", label: "Routines", labelKey: "botSettings.sections.routines", icon: CalendarClock, keywords: ["schedule", "routines", "cron", "tasks"] },
  { id: "access", label: "Access", labelKey: "botSettings.sections.access", icon: Network, keywords: ["works on", "computer", "vm", "cloud", "vps", "folder", "workspace", "browser", "connected apps", "composio", "webhooks", "always allow", "grants", "tool selection", "tools", "mcp", "allow", "exclude"] },
  { id: "model", label: "Model", labelKey: "botSettings.sections.model", icon: Cpu, keywords: ["engine", "model", "provider", "cli", "effort"] },
];
