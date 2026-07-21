import React, { type ReactNode } from "react";

export function MarkdownText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      blocks.push(<h4 key={`h-${blocks.length}`}>{renderInline(line.slice(4))}</h4>);
    } else if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h4 key={`h-${blocks.length}`}>{renderInline(line.slice(3))}</h4>);
    } else if (line.startsWith("- ")) {
      list.push(<li key={`li-${blocks.length}-${list.length}`}>{renderInline(line.slice(2))}</li>);
    } else if (/^\d+\.\s/.test(line)) {
      list.push(
        <li key={`li-${blocks.length}-${list.length}`}>
          {renderInline(line.replace(/^\d+\.\s/, ""))}
        </li>,
      );
    } else {
      flushList();
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return (
    <div className="space-y-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_h4]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground">
      {blocks}
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
