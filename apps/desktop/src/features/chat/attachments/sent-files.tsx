"use client";

// 时间线里用户消息的附件：消息末尾的 `<file>` 引用（Core 原生格式）解析成文件标签，
// 不把路径与内联的文件内容原样铺在气泡里。悬停看完整路径；内联了内容的文本文件注明“已附上内容”。
import type { FileTag } from "@primus/protocol";
import { File, ImageIcon } from "lucide-react";
import { strings } from "@/lib/strings";
import { attachmentKind } from "./attachment-kind";
import { ICONS } from "./attachment-tile";

const t = strings.chat.attachments;

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function SentFiles({ files }: { files: FileTag[] }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label={t.sent} className="flex max-w-full flex-wrap justify-end gap-1.5">
      {files.map((f, i) => {
        const kind = attachmentKind(f.path);
        const Icon = kind === "image" ? ImageIcon : (ICONS[kind] ?? File);
        const name = baseName(f.path);
        const inlined = f.content !== undefined;
        return (
          <li
            // 同一路径可能出现两次（重发），按位置区分
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表只随消息整体替换，不会重排
            key={`${i}-${f.path}`}
            title={inlined ? `${f.path}\n${t.inlined}` : f.path}
            aria-label={inlined ? `${name}（${t.inlined}）` : name}
            className="flex h-7 max-w-56 items-center gap-1.5 rounded-[9px] bg-tile px-2 text-[12px] ring-1 ring-tile-ring"
          >
            <Icon aria-hidden size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate">{name}</span>
          </li>
        );
      })}
    </ul>
  );
}
