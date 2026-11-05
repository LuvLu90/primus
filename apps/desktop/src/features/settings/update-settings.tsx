"use client";

import { useEffect, useId, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { Switch } from "@/components/ui/switch";
import { useRestartUpdate } from "@/features/update/restart-update";
import { useUpdateStore } from "@/features/update/update-store";
import type { UpdateChannel, UpdateStatus } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { Row, Section } from "./settings-section";

const tu = strings.settings.update;
const CHANNELS: UpdateChannel[] = ["stable", "beta"];

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** 检查 / 下载进行中或检查结果的一行说明 */
export function updateStateText(status: UpdateStatus, checked: boolean): string | null {
  if (status.phase === "checking") return tu.checking;
  if (status.phase === "installing") return tu.installing;
  if (status.phase === "downloading") {
    const p = status.progress;
    if (p?.total) {
      const n = Math.min(100, Math.floor((p.downloaded / p.total) * 100));
      return tu.downloadingPercent.replace("{n}", String(n));
    }
    return tu.downloading;
  }
  if (status.pending) return tu.pendingReady.replace("{version}", status.pending.version);
  if (status.lastError) return tu.lastError.replace("{message}", status.lastError);
  return checked ? tu.upToDate : null;
}

// 设置·更新（第 18 章、第 3.6 节）：当前版本、自动更新开关（默认开）、通道（稳定 / Beta）、立即检查。
// 下载完成后的重启提示由根布局中的 UpdatePrompt 显示。
export function UpdateSettings() {
  const status = useUpdateStore((s) => s.status);
  const loadError = useUpdateStore((s) => s.loadError);
  const start = useUpdateStore((s) => s.start);
  const check = useUpdateStore((s) => s.check);
  const setSettings = useUpdateStore((s) => s.setSettings);
  const [checked, setChecked] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const channelLabel = useId();
  const restartUpdate = useRestartUpdate();

  useEffect(() => {
    void start();
  }, [start]);

  if (!status) {
    return loadError ? (
      <p className="text-sm text-danger">{loadError || tu.loadFailed}</p>
    ) : (
      <p className="text-sm text-muted">{tu.loading}</p>
    );
  }

  const save = async (patch: Parameters<typeof setSettings>[0]) => {
    setSaving(true);
    setActionError(null);
    try {
      await setSettings(patch);
    } catch (e) {
      setActionError(errorText(e, tu.saveFailed));
    } finally {
      setSaving(false);
    }
  };
  const checkNow = async () => {
    setActionError(null);
    try {
      await check();
      setChecked(true);
    } catch (e) {
      setActionError(errorText(e, tu.checkFailed));
    }
  };
  const working = status.phase !== "idle";
  const stateText = updateStateText(status, checked);

  return (
    <div className="flex flex-col gap-6">
      {actionError && (
        <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          <p className="text-danger">{actionError}</p>
        </div>
      )}
      <Section title={tu.title}>
        <Row label={tu.currentVersion} hint={status.available ? undefined : tu.unavailableHint}>
          <span className="text-sm text-muted tabular-nums">{status.currentVersion}</span>
        </Row>
        <Row label={tu.autoUpdate} hint={tu.autoUpdateHint}>
          <Switch
            ariaLabel={tu.autoUpdate}
            checked={status.settings.autoUpdate}
            disabled={saving}
            onCheckedChange={(autoUpdate) => void save({ autoUpdate })}
          />
        </Row>
        <Row label={tu.channel} hint={tu.channelHint} labelId={channelLabel}>
          <Tabs
            value={status.settings.channel}
            onValueChange={(v) => void save({ channel: v as UpdateChannel })}
          >
            <TabsList aria-labelledby={channelLabel}>
              {CHANNELS.map((c) => (
                <TabsTrigger key={c} value={c} disabled={saving}>
                  {tu.channels[c]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Row>
        <Row label={tu.checkNow} hint={stateText ?? undefined}>
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={!status.available || working}
            className="shrink-0 rounded-full px-3 py-1 text-sm ring-1 ring-border transition-colors enabled:hover:bg-hover disabled:opacity-50"
          >
            {status.phase === "checking" ? tu.checking : tu.checkNow}
          </button>
        </Row>
        {status.pending && (
          <Row
            label={tu.pendingReady.replace("{version}", status.pending.version)}
            hint={restartUpdate.error ?? undefined}
          >
            <button
              type="button"
              onClick={restartUpdate.restart}
              disabled={restartUpdate.working}
              className="shrink-0 rounded-full bg-fg px-3 py-1 text-sm font-medium text-surface transition-opacity enabled:hover:opacity-90 disabled:opacity-50"
            >
              {strings.update.restartNow}
            </button>
          </Row>
        )}
      </Section>
      {restartUpdate.dialog}
    </div>
  );
}
