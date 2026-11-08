import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { StoreProvider, type Bot, type Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";
import {
  PendingApprovalActions,
  PendingApprovalPanel,
  spokenApprovalPrompt,
  type Pending,
} from "./PendingApproval";

function commandApproval(answered?: "allow" | "deny"): { message: Message; pending: Pending } {
  const message: Message = {
    id: "approval-card",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Approval needed",
      subtitle: "pnpm test",
      options: ["Allow", "Deny"],
      answered,
      requestId: "approval-request",
      tool: "Bash",
    },
  };
  return {
    message,
    pending: {
      message,
      requestId: "approval-request",
      tool: "Bash",
      allowKey: "Bash:pnpm test",
      detail: "pnpm test",
    },
  };
}

afterEach(() => {
  setLocale("en");
});

describe("approval cards in the app's language", () => {
  it("renders a pending command approval", () => {
    setLocale("zh");
    const { message } = commandApproval();

    const markup = renderToStaticMarkup(createElement(ApprovalCard, {
      bot: { name: "Mochi" } as Bot,
      message,
    }));

    expect(markup).toContain("Mochi 想执行命令");
    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain("正在等待你在下方回答");
  });

  it("renders a denied command approval", () => {
    setLocale("zh");
    const { message } = commandApproval("deny");

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));

    expect(markup).toContain("已拒绝");
  });

  it("renders the pending approval strip", () => {
    setLocale("zh");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, {
      pending,
      count: 3,
      index: 1,
    }));

    expect(markup).toContain('aria-label="待批准"');
    expect(markup).toContain("待批准");
    expect(markup).toContain("第 2 / 3 条");
    expect(markup).toContain("请求批准命令");
    expect(markup).toContain('aria-label="待查看的批准详情"');
  });

  it("speaks a command approval", () => {
    setLocale("zh");
    const { pending } = commandApproval();

    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(
      "Mochi 想执行命令。pnpm test。我要允许吗？",
    );
  });

  it("renders command approval actions", () => {
    setLocale("zh");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(PendingApprovalActions, {
        pending,
        threadId: "thread-1",
        bot: { id: "bot-1", name: "Mochi" } as Bot,
        onCancelTurn: () => undefined,
      }),
    ));

    expect(markup).toContain("取消本轮");
    expect(markup).toContain("拒绝");
    expect(markup).toContain("始终允许");
    expect(markup).toContain("允许一次");
    expect(markup).toContain("不再就 Bash:pnpm test 询问 Mochi");
  });

  it("speaks a skill approval", () => {
    setLocale("zh");

    expect(spokenApprovalPrompt(skillUpdateApproval(), "Mochi")).toBe(
      'Mochi 询问：Update the "lancar-despesa" skill? 请在屏幕上查看该技能。我要更新它吗？',
    );
  });
});

function skillUpdateApproval(): Pending {
  const message: Message = {
    id: "skill-update-card",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: 'Update the "lancar-despesa" skill?',
      subtitle: "Logs an expense in the company portal.",
      options: ["Update", "Deny"],
      requestId: "skill-update-request",
      tool: "update_skill",
      skillRequest: {
        version: 1,
        requestId: "skill-update-request",
        botId: "bot-1",
        threadId: "thread-1",
        stagedId: "staged-update",
        action: "update",
        name: "lancar-despesa",
        gist: "Logs an expense in the company portal.",
        warnings: [],
        createdAt: 1,
      },
    },
  };
  return {
    message,
    requestId: "skill-update-request",
    tool: "update_skill",
    detail: message.card!.subtitle,
  };
}
