"use client";

import { RadioGroup } from "radix-ui";
import { useEffect, useId, useState } from "react";
import { type AuthStatus, getPlatform, type ModelSummary, type ModelsInfo } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { useModelsInfo } from "@/lib/use-models";
import { cn } from "@/lib/utils";
import { Row, Section } from "./settings-section";

const ta = strings.settings.account;
const tm = strings.settings.models;

/** 令牌数的简写：1,000,000 → 1M，128,000 → 128K */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-2xs text-muted dark:bg-white/[0.08]">
      {children}
    </span>
  );
}

// 设置·账号（第 9.7 节）：账号服务接入前显示未登录与说明，登录 / 登出按钮禁用（loginAvailable 为 false）。
export function AccountSettings() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPlatform()
      .then((p) => p.authStatus())
      .then((s) => !cancelled && setStatus(s))
      .catch((e: unknown) => !cancelled && setError(errorText(e, ta.loadFailed)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!status) return <p className="text-sm text-muted">{ta.loading}</p>;

  const account = status.loggedIn ? status.account : null;
  return (
    <Section title={ta.title}>
      <Row label={account?.name ?? ta.notSignedIn}>
        {status.loggedIn && <span className="shrink-0 text-sm text-muted">{ta.signedIn}</span>}
      </Row>
      <Row label={status.loggedIn ? ta.logout : ta.login} hint={ta.loginUnavailable}>
        <button
          type="button"
          disabled={!status.loginAvailable}
          className="rounded-full px-3 py-1 text-sm ring-1 ring-border transition-colors enabled:hover:bg-hover disabled:opacity-50"
        >
          {status.loggedIn ? ta.logout : ta.login}
        </button>
      </Row>
    </Section>
  );
}

function ModelDetail({ model }: { model: ModelSummary }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      <Badge>{tm.protocols[model.api] ?? model.api}</Badge>
      <Badge>{`${tm.context} ${formatTokens(model.contextWindow)}`}</Badge>
      <Badge>{`${tm.maxOutput} ${formatTokens(model.maxTokens)}`}</Badge>
      {model.image && <Badge>{tm.image}</Badge>}
      {model.reasoning && <Badge>{tm.reasoning}</Badge>}
    </span>
  );
}

// 设置·模型（第 9.5 节）：从已启用渠道的模型中改选默认模型（新会话生效）；显示压缩与标题使用的模型与配置错误。
// 随 models_watch 更新：添加、修改渠道或后台获取到模型列表后立即刷新。
export function ModelSettings() {
  const { info, error: loadError, update } = useModelsInfo();
  const error = loadError ? errorText(loadError, tm.loadFailed) : null;
  // 改选与刷新的失败分别用各自的标题
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const labelId = useId();

  const run = async (action: () => Promise<ModelsInfo>, title: string) => {
    setBusy(true);
    setActionError(null);
    try {
      update(await action());
    } catch (e) {
      setActionError({ title, message: errorText(e, title) });
    } finally {
      setBusy(false);
    }
  };

  const choose = (key: string) =>
    run(async () => (await getPlatform()).modelsSetDefault(key), tm.saveFailed);
  const refresh = () => run(async () => (await getPlatform()).modelsRefresh(), tm.refreshFailed);

  if (!info) {
    return error ? (
      <p className="text-sm text-danger">{error}</p>
    ) : (
      <p className="text-sm text-muted">{tm.loading}</p>
    );
  }

  const nameOf = (key: string | null) => info.models.find((m) => m.key === key)?.name ?? key ?? "—";

  return (
    <div className="flex flex-col gap-6">
      {info.error && (
        <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          <p className="font-medium text-danger">{tm.configError}</p>
          <p className="mt-1 text-muted">{info.error}</p>
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          <p className="font-medium text-danger">{actionError.title}</p>
          <p className="mt-1 text-muted">{actionError.message}</p>
        </div>
      )}
      <Section title={tm.defaultModel}>
        <p id={labelId} className="sr-only">
          {tm.defaultModel}
        </p>
        <RadioGroup.Root
          aria-labelledby={labelId}
          value={info.defaultModel ?? undefined}
          onValueChange={choose}
          disabled={busy}
          className="flex flex-col"
        >
          {info.models.length === 0 && !info.error && (
            <p className="px-4 pt-1 pb-3 text-sm text-muted">{tm.noModels}</p>
          )}
          {info.models.map((model) => (
            <RadioGroup.Item
              key={model.key}
              value={model.key}
              aria-label={model.name}
              className={cn(
                "flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-hover",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              <span className="mt-1 flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-border">
                <RadioGroup.Indicator className="size-2 rounded-full bg-accent" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{model.name}</span>
                <ModelDetail model={model} />
              </span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </Section>
      <Section title={tm.background}>
        <Row label={nameOf(info.compactionModel)}>
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="shrink-0 rounded-full px-3 py-1 text-sm ring-1 ring-border transition-colors enabled:hover:bg-hover disabled:opacity-50"
          >
            {busy ? tm.refreshing : tm.refresh}
          </button>
        </Row>
      </Section>
    </div>
  );
}
