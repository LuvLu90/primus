"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { Switch } from "@/components/ui/switch";
import {
  getPlatform,
  type ProviderApi,
  type ProviderFetchInput,
  type ProviderModel,
  type ProviderSaveInput,
  type ProvidersChanged,
  type ProviderView,
} from "@/lib/platform";
import { strings } from "@/lib/strings";
import { publishModels, subscribeModels } from "@/lib/use-models";
import { cn } from "@/lib/utils";
import { Badge, errorText } from "./account-models";

// 设置·模型·模型渠道：列出渠道（协议、接口地址、密钥末 4 位、模型数、启用开关），可添加、编辑、删除。
// 添加 / 编辑在对话框中进行：填协议、接口地址与密钥后“获取模型”（provider_fetch_models，不保存），
// 勾选要用的模型并可调整上下文长度、最大输出、是否支持图片与思考，保存时一次提交（provider_save）。
// 密钥从不回显：编辑时留空表示保留已存的密钥。

const t = strings.settings.providers;
const td = t.dialog;
const protocols = strings.settings.models.protocols;
const APIS: ProviderApi[] = ["openai-responses", "anthropic-messages"];
const NAME_MAX = 64;

const buttonClass =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm ring-1 ring-border transition-colors enabled:hover:bg-hover disabled:opacity-50 motion-reduce:transition-none";
const iconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 motion-reduce:transition-none";
const inputClass =
  "w-full rounded-xl bg-black/[0.04] px-3 py-2 text-sm text-fg outline-none ring-1 ring-border transition-shadow placeholder:text-muted focus:ring-2 focus:ring-accent/50 aria-[invalid=true]:ring-danger/60 motion-reduce:transition-none dark:bg-white/[0.06]";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));

/** 与薄壳一致：HTTP(S)、有主机、不含空白与查询参数 / 片段（请求路径拼在地址后面） */
const validUrl = (url: string) => /^https?:\/\/[^\s/?#]+[^\s?#]*$/i.test(url.trim());
const positiveInt = (v: string) => /^\d+$/.test(v.trim()) && Number(v) > 0;

/** 模型数与密钥一行 */
function providerMeta(p: ProviderView): string {
  const key = p.hasKey
    ? p.keyHint
      ? fill(t.keyMasked, { hint: p.keyHint })
      : t.keySet
    : t.keyUnset;
  return `${t.key} ${key} · ${fill(t.modelCount, { n: p.models.length })}`;
}

/** 渠道 → 保存参数（不含密钥：缺省表示保留已存的密钥） */
function saveInputOf(p: ProviderView, patch: Partial<ProviderSaveInput>): ProviderSaveInput {
  return {
    id: p.id,
    name: p.name,
    api: p.api,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    models: p.models,
    ...patch,
  };
}

export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 正在编辑的渠道；"new" 为添加 */
  const [editing, setEditing] = useState<ProviderView | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderView | null>(null);
  const hintId = useId();

  // 每次读取或应用保存结果加一：较早发出的 providersList 响应迟到时不覆盖新状态
  const listSeq = useRef(0);

  // 首次读取 + 模型配置变化（保存、删除、后台获取到模型列表）时重新读取
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const seq = ++listSeq.current;
      return getPlatform()
        .then((p) => p.providersList())
        .then((list) => {
          if (cancelled || seq !== listSeq.current) return;
          setProviders(list);
          setLoadError(null);
        })
        .catch(
          (e: unknown) =>
            !cancelled && seq === listSeq.current && setLoadError(errorText(e, t.loadFailed)),
        );
    };
    void load();
    const unsubscribe = subscribeModels(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const applyChanged = (changed: ProvidersChanged) => {
    listSeq.current++;
    setProviders(changed.providers);
    setLoadError(null);
    publishModels(changed.models);
  };

  const run = async (id: string, title: string, action: () => Promise<ProvidersChanged>) => {
    setBusy(id);
    setActionError(null);
    try {
      applyChanged(await action());
    } catch (e) {
      setActionError({ title, message: errorText(e, title) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: ProviderView, enabled: boolean) =>
    run(p.id, t.toggleFailed, async () =>
      (await getPlatform()).providerSave(saveInputOf(p, { enabled })),
    );

  const confirmDelete = () => {
    const p = pendingDelete;
    setPendingDelete(null);
    if (p) void run(p.id, t.deleteFailed, async () => (await getPlatform()).providerDelete(p.id));
  };

  // 读取失败（如 providers.json 损坏）时仍显示添加入口：薄壳保存时备份旧文件并重建配置
  const list = providers ?? (loadError ? [] : null);
  if (!list) return <p className="text-sm text-muted">{t.loading}</p>;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-xs font-medium text-muted">{t.title}</h3>
      {loadError && (
        <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          <p className="font-medium text-danger">{loadError}</p>
          {/* 之前读到过列表时显示的是旧列表，只提示读取失败；从未读到时说明保存会重建配置 */}
          {!providers && <p className="mt-1 text-muted">{t.loadFailedRecover}</p>}
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          <p className="font-medium text-danger">{actionError.title}</p>
          <p className="mt-1 text-muted">{actionError.message}</p>
        </div>
      )}
      <div className="divide-y divide-border rounded-2xl bg-white/70 shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.08]">
        <p id={hintId} className="px-4 py-3 text-xs text-muted">
          {list.length === 0 ? t.empty : t.hint}
        </p>
        {list.length > 0 && (
          <ul aria-label={t.title} aria-describedby={hintId} className="divide-y divide-border">
            {list.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="truncate font-medium">{p.name}</span>
                    <Badge>{protocols[p.api] ?? p.api}</Badge>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted" title={p.baseUrl}>
                    {p.baseUrl}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{providerMeta(p)}</p>
                </div>
                <Switch
                  ariaLabel={fill(t.enable, { name: p.name })}
                  checked={p.enabled}
                  disabled={busy !== null}
                  onCheckedChange={(enabled) => void toggle(p, enabled)}
                />
                <button
                  type="button"
                  aria-label={fill(t.editLabel, { name: p.name })}
                  title={t.edit}
                  disabled={busy !== null}
                  onClick={() => setEditing(p)}
                  className={iconButtonClass}
                >
                  <Icon name="pen" />
                </button>
                <button
                  type="button"
                  aria-label={fill(t.deleteLabel, { name: p.name })}
                  title={t.delete}
                  disabled={busy !== null}
                  onClick={() => setPendingDelete(p)}
                  className={cn(iconButtonClass, "hover:text-danger")}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={() => setEditing("new")}
            disabled={busy !== null}
            className={buttonClass}
          >
            <Icon name="plus" size="sm" />
            {t.add}
          </button>
        </div>
      </div>

      {editing !== null && (
        <ProviderDialog
          provider={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(changed) => {
            applyChanged(changed);
            setEditing(null);
          }}
        />
      )}

      <GlassDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <GlassDialogContent>
          <GlassDialogTitle>
            {pendingDelete ? fill(t.deleteTitle, { name: pendingDelete.name }) : null}
          </GlassDialogTitle>
          <GlassDialogDescription>{t.deleteDescription}</GlassDialogDescription>
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <GlassDialogClose asChild>
              <button type="button" className="rounded-full bg-hover px-4 py-1.5">
                {t.cancel}
              </button>
            </GlassDialogClose>
            <button
              type="button"
              onClick={confirmDelete}
              className="rounded-full bg-hover px-4 py-1.5 font-medium text-danger ring-1 ring-danger/40"
            >
              {t.deleteConfirm}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>
    </section>
  );
}

/** 对话框中的一个模型：参数用字符串保存输入框内容，保存时再校验 */
export interface DraftModel {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: string;
  maxTokens: string;
  selected: boolean;
  /** 最近一次获取的结果中有这个模型（未获取过时为 true） */
  listed: boolean;
}

function toDraft(m: ProviderModel, selected: boolean): DraftModel {
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    image: m.input.includes("image"),
    contextWindow: String(m.contextWindow),
    maxTokens: String(m.maxTokens),
    selected,
    listed: true,
  };
}

/** 草稿 → 薄壳的模型参数（只含契约里的六个字段） */
function toModel(d: DraftModel): ProviderModel {
  return {
    id: d.id,
    name: d.name,
    reasoning: d.reasoning,
    input: d.image ? ["text", "image"] : ["text"],
    contextWindow: Number(d.contextWindow.trim()),
    maxTokens: Number(d.maxTokens.trim()),
  };
}

/** 能力仍是默认参数（不思考、仅文本、128000 / 32000，与薄壳一致）：多半是当时没识别出来，而不是用户改的 */
function hasDefaultCapabilities(d: DraftModel): boolean {
  return (
    !d.reasoning &&
    !d.image &&
    d.contextWindow.trim() === "128000" &&
    d.maxTokens.trim() === "32000"
  );
}

/**
 * 合并获取结果：对话框里已有的模型保留勾选与改过的参数（能力仍是默认参数的按这次获取的结果重新识别，名称与勾选保留）；
 * 新模型在还没有任何模型时默认全选，否则不选；已勾选但接口没列出的模型保留（标“接口未列出”），未勾选的丢弃
 */
export function mergeFetched(prev: DraftModel[], fetched: ProviderModel[]): DraftModel[] {
  const byId = new Map(prev.map((d) => [d.id, d]));
  const selectNew = prev.length === 0;
  const merged = fetched.map((m) => {
    const old = byId.get(m.id);
    if (!old) return toDraft(m, selectNew);
    if (!hasDefaultCapabilities(old)) return { ...old, listed: true };
    return { ...toDraft(m, old.selected), name: old.name };
  });
  const fetchedIds = new Set(fetched.map((m) => m.id));
  for (const d of prev) {
    if (!fetchedIds.has(d.id) && d.selected) merged.push({ ...d, listed: false });
  }
  return merged;
}

interface FieldErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
}

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  /** 编辑的渠道；null 为添加 */
  provider: ProviderView | null;
  onClose: () => void;
  onSaved: (changed: ProvidersChanged) => void;
}) {
  const editing = provider !== null;
  const [name, setName] = useState(provider?.name ?? "");
  const [api, setApi] = useState<ProviderApi>(provider?.api ?? "openai-responses");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<DraftModel[]>(
    () => provider?.models.map((m) => toDraft(m, true)) ?? [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [modelErrors, setModelErrors] = useState<Record<string, ("contextWindow" | "maxTokens")[]>>(
    {},
  );
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fetchSeq = useRef(0);
  const ids = {
    name: useId(),
    api: useId(),
    baseUrl: useId(),
    apiKey: useId(),
    fetch: useId(),
    models: useId(),
  };
  const hasSavedKey = provider?.hasKey ?? false;

  /** 协议、地址或密钥变了：进行中的获取结果与错误作废（不再并入列表），可以立即重新获取 */
  const invalidateFetch = () => {
    fetchSeq.current++;
    setFetching(false);
  };

  const updateModel = (id: string, patch: Partial<DraftModel>) =>
    setModels((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fetchModels = async () => {
    const key = apiKey.trim();
    const url = baseUrl.trim();
    setFetchError(null);
    if (!url || (!key && !hasSavedKey)) {
      setFetchError(td.errors.fetchNeeds);
      return;
    }
    if (!validUrl(url)) {
      setErrors((e) => ({ ...e, baseUrl: td.errors.baseUrlInvalid }));
      setFetchError(td.errors.baseUrlInvalid);
      return;
    }
    // 编辑时带上渠道 ID，用输入框里的协议、地址（以及新填的密钥）覆盖已保存的值
    const input: ProviderFetchInput = editing
      ? { id: provider.id, api, baseUrl: url, ...(key ? { apiKey: key } : {}) }
      : { api, baseUrl: url, apiKey: key };
    const seq = ++fetchSeq.current;
    setFetching(true);
    try {
      const fetched = await (await getPlatform()).providerFetchModels(input);
      if (seq !== fetchSeq.current) return;
      setModels((prev) => mergeFetched(prev, fetched));
    } catch (e) {
      if (seq === fetchSeq.current) setFetchError(errorText(e, td.fetchFailed));
    } finally {
      if (seq === fetchSeq.current) setFetching(false);
    }
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    const trimmed = name.trim();
    if (!trimmed) next.name = td.errors.nameRequired;
    else if ([...trimmed].length > NAME_MAX) next.name = td.errors.nameTooLong;
    if (!validUrl(baseUrl)) next.baseUrl = td.errors.baseUrlInvalid;
    if (!editing && !apiKey.trim()) next.apiKey = td.errors.apiKeyRequired;
    const badModels: Record<string, ("contextWindow" | "maxTokens")[]> = {};
    for (const d of models) {
      if (!d.selected) continue;
      const bad = (["contextWindow", "maxTokens"] as const).filter((f) => !positiveInt(d[f]));
      if (bad.length) badModels[d.id] = bad;
    }
    setErrors(next);
    setModelErrors(badModels);
    // 参数有误的模型展开，让错误可见
    const badIds = Object.keys(badModels);
    if (badIds.length) setExpanded((prev) => new Set([...prev, ...badIds]));
    return Object.keys(next).length === 0 && badIds.length === 0;
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    if (!validate()) return;
    const key = apiKey.trim();
    const input: ProviderSaveInput = {
      ...(editing ? { id: provider.id } : {}),
      name: name.trim(),
      api,
      baseUrl: baseUrl.trim(),
      ...(key ? { apiKey: key } : {}),
      enabled: provider?.enabled ?? true,
      models: models.filter((d) => d.selected).map(toModel),
    };
    setSaving(true);
    try {
      onSaved(await (await getPlatform()).providerSave(input));
    } catch (err) {
      setSaveError(errorText(err, td.saveFailed));
      setSaving(false);
    }
  };

  const selectedCount = models.filter((d) => d.selected).length;
  const allSelected = models.length > 0 && selectedCount === models.length;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [selectedCount, allSelected]);

  const fieldError = (id: string, message: string | undefined) =>
    message ? (
      <p id={`${id}-error`} className="mt-1 text-xs text-danger">
        {message}
      </p>
    ) : null;

  return (
    <GlassDialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <GlassDialogContent>
        <GlassDialogTitle>{editing ? td.editTitle : td.addTitle}</GlassDialogTitle>
        <GlassDialogDescription>{td.description}</GlassDialogDescription>
        <form onSubmit={save} noValidate className="mt-4 flex flex-col gap-3">
          <div className="scroll-thin -mx-1 flex max-h-[min(60vh,560px)] flex-col gap-3 overflow-y-auto px-1 pb-1">
            <div>
              <label htmlFor={ids.name} className="mb-1 block text-xs text-muted">
                {td.name}
              </label>
              <input
                id={ids.name}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={td.namePlaceholder}
                maxLength={NAME_MAX * 2}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${ids.name}-error` : undefined}
                className={inputClass}
              />
              {fieldError(ids.name, errors.name)}
            </div>
            <div>
              <label htmlFor={ids.api} className="mb-1 block text-xs text-muted">
                {td.api}
              </label>
              <select
                id={ids.api}
                value={api}
                onChange={(e) => {
                  invalidateFetch();
                  setApi(e.target.value as ProviderApi);
                }}
                className={inputClass}
              >
                {APIS.map((a) => (
                  <option key={a} value={a}>
                    {protocols[a]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={ids.baseUrl} className="mb-1 block text-xs text-muted">
                {td.baseUrl}
              </label>
              <input
                id={ids.baseUrl}
                type="url"
                value={baseUrl}
                onChange={(e) => {
                  invalidateFetch();
                  setBaseUrl(e.target.value);
                }}
                placeholder={td.baseUrlPlaceholder}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.baseUrl ? true : undefined}
                aria-describedby={errors.baseUrl ? `${ids.baseUrl}-error` : undefined}
                className={inputClass}
              />
              {fieldError(ids.baseUrl, errors.baseUrl)}
            </div>
            <div>
              <label htmlFor={ids.apiKey} className="mb-1 block text-xs text-muted">
                {td.apiKey}
              </label>
              <input
                id={ids.apiKey}
                type="password"
                value={apiKey}
                onChange={(e) => {
                  invalidateFetch();
                  setApiKey(e.target.value);
                }}
                placeholder={hasSavedKey ? td.apiKeyKeep : td.apiKeyPlaceholder}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.apiKey ? true : undefined}
                aria-describedby={errors.apiKey ? `${ids.apiKey}-error` : undefined}
                className={inputClass}
              />
              {fieldError(ids.apiKey, errors.apiKey)}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void fetchModels()}
                disabled={fetching || saving}
                aria-describedby={fetchError ? ids.fetch : undefined}
                className={buttonClass}
              >
                {fetching ? td.fetching : td.fetch}
              </button>
              {models.length > 0 && (
                <span className="text-xs text-muted">
                  {fill(td.selectedCount, { n: selectedCount, total: models.length })}
                </span>
              )}
            </div>
            {fetchError && (
              <p id={ids.fetch} role="alert" className="text-xs text-danger">
                {fetchError}
              </p>
            )}

            <div>
              <p id={ids.models} className="mb-1 text-xs text-muted">
                {td.models}
              </p>
              {models.length === 0 ? (
                <p className="rounded-xl px-3 py-3 text-xs text-muted ring-1 ring-border">
                  {td.modelsEmpty}
                </p>
              ) : (
                <fieldset aria-labelledby={ids.models} className="rounded-xl ring-1 ring-border">
                  <label className="flex items-center gap-2.5 border-border border-b px-3 py-2 text-sm">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => {
                        const selected = e.target.checked;
                        setModels((list) => list.map((d) => ({ ...d, selected })));
                      }}
                      className="size-4 accent-accent"
                    />
                    {td.selectAll}
                  </label>
                  <ul className="divide-y divide-border">
                    {models.map((d) => (
                      <ModelRow
                        key={d.id}
                        model={d}
                        open={d.selected && expanded.has(d.id)}
                        errors={modelErrors[d.id] ?? []}
                        onToggleOpen={() => toggleExpanded(d.id)}
                        onChange={(patch) => updateModel(d.id, patch)}
                      />
                    ))}
                  </ul>
                </fieldset>
              )}
            </div>
          </div>

          {saveError && (
            <div role="alert" className="rounded-xl px-3 py-2 text-xs ring-1 ring-danger/40">
              <p className="font-medium text-danger">{td.saveFailed}</p>
              <p className="mt-0.5 text-muted">{saveError}</p>
            </div>
          )}
          <div className="flex justify-end gap-2 text-sm">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-full bg-hover px-4 py-1.5 disabled:opacity-50"
            >
              {td.cancel}
            </button>
            <button
              type="submit"
              disabled={saving || fetching}
              className="rounded-full bg-fg px-4 py-1.5 font-medium text-surface disabled:opacity-40"
            >
              {saving ? td.saving : td.save}
            </button>
          </div>
        </form>
      </GlassDialogContent>
    </GlassDialog>
  );
}

function ModelRow({
  model,
  open,
  errors,
  onToggleOpen,
  onChange,
}: {
  model: DraftModel;
  open: boolean;
  errors: ("contextWindow" | "maxTokens")[];
  onToggleOpen: () => void;
  onChange: (patch: Partial<DraftModel>) => void;
}) {
  const panelId = useId();
  const ctxId = useId();
  const maxId = useId();
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2.5">
        <label className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={model.selected}
            onChange={(e) => onChange({ selected: e.target.checked })}
            aria-label={model.name}
            className="size-4 shrink-0 accent-accent"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{model.name}</span>
            {(model.name !== model.id || !model.listed) && (
              <span className="block truncate text-2xs text-muted">
                {model.name !== model.id ? model.id : null}
                {model.name !== model.id && !model.listed ? " · " : null}
                {!model.listed ? td.notListed : null}
              </span>
            )}
          </span>
        </label>
        {model.selected && (
          <button
            type="button"
            aria-label={fill(td.expand, { name: model.name })}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={onToggleOpen}
            className={cn(iconButtonClass, "size-7")}
          >
            <Icon
              name="chevron-down"
              size="sm"
              className={cn(
                "transition-transform duration-200 motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
        )}
      </div>
      {open && (
        <fieldset
          id={panelId}
          aria-label={fill(td.expand, { name: model.name })}
          className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 pl-6.5"
        >
          <div>
            <label htmlFor={ctxId} className="mb-0.5 block text-2xs text-muted">
              {td.contextWindow}
            </label>
            <input
              id={ctxId}
              inputMode="numeric"
              value={model.contextWindow}
              onChange={(e) => onChange({ contextWindow: e.target.value })}
              aria-invalid={errors.includes("contextWindow") ? true : undefined}
              aria-describedby={errors.includes("contextWindow") ? `${ctxId}-error` : undefined}
              className={cn(inputClass, "px-2 py-1")}
            />
            {errors.includes("contextWindow") && (
              <p id={`${ctxId}-error`} className="mt-0.5 text-2xs text-danger">
                {td.errors.positiveInt}
              </p>
            )}
          </div>
          <div>
            <label htmlFor={maxId} className="mb-0.5 block text-2xs text-muted">
              {td.maxTokens}
            </label>
            <input
              id={maxId}
              inputMode="numeric"
              value={model.maxTokens}
              onChange={(e) => onChange({ maxTokens: e.target.value })}
              aria-invalid={errors.includes("maxTokens") ? true : undefined}
              aria-describedby={errors.includes("maxTokens") ? `${maxId}-error` : undefined}
              className={cn(inputClass, "px-2 py-1")}
            />
            {errors.includes("maxTokens") && (
              <p id={`${maxId}-error`} className="mt-0.5 text-2xs text-danger">
                {td.errors.positiveInt}
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={model.image}
              onChange={(e) => onChange({ image: e.target.checked })}
              className="size-3.5 accent-accent"
            />
            {td.image}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={model.reasoning}
              onChange={(e) => onChange({ reasoning: e.target.checked })}
              className="size-3.5 accent-accent"
            />
            {td.reasoning}
          </label>
        </fieldset>
      )}
    </li>
  );
}
