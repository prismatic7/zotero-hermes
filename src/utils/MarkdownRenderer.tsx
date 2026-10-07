import { memo, ReactNode } from "react";

/**
 * Lightweight Markdown-to-React renderer for the Zotero Firefox sandbox.
 * Does NOT use dangerouslySetInnerHTML or DOMParser (both crash the sandbox).
 * Instead, parses markdown syntax and returns React elements directly.
 *
 * Supports:
 *   - Headers (# ## ###)
 *   - Bold (**text**)
 *   - Italic (*text* or _text_)
 *   - Inline code (`code`)
 *   - Links [text](url)
 *   - Unordered lists (- item)
 *   - Ordered lists (1. item)
 *   - Blockquotes (> text)
 *   - Horizontal rules (---)
 *   - Line breaks
 */

interface InlineSegment {
  type:
    | "text"
    | "bold"
    | "italic"
    | "code"
    | "link"
    | "strikethrough"
    | "doi"
    | "url";
  content: string;
  url?: string;
}

/**
 * Validate that a URL uses a safe, permitted scheme before rendering as an active link.
 * Blocks javascript:, chrome:, file:, data:, and other arbitrary schemes from executing
 * in Zotero's privileged chrome window context.
 */
export function isSafeUrl(url?: string): boolean {
  if (!url) return false;
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("add-context:") ||
    trimmed.startsWith("apply-tag:") ||
    trimmed.startsWith("action:")
  );
}

export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = text;

  const patterns = [
    { regex: /\*\*([^*]+)\*\*/g, type: "bold" as const },
    { regex: /__([^_]+)__/g, type: "bold" as const },
    { regex: /`([^`]+)`/g, type: "code" as const },
    { regex: /\*([^*]+)\*/g, type: "italic" as const },
    { regex: /_([^_]+)_/g, type: "italic" as const },
    { regex: /~~([^~]+)~~/g, type: "strikethrough" as const },
    {
      regex: /\[([^\]]+)\]\(((?:[^()\\]|\\.|\([^()\\]*\))*)\)/g,
      type: "link" as const,
    },
    // Bare URLs auto-link
    { regex: /(https?:\/\/[^\s<>]+)/g, type: "url" as const },
    // Bare DOIs (with optional doi: prefix) auto-link to doi.org. The
    // negative lookbehind prevents matching a DOI that is already part of
    // a full https://doi.org/ URL (e.g. after the slash in
    // "https://doi.org/10.21476/pp.2017.33162").
    {
      regex: /(?<![\w/])((?:doi:\s*)?10\.\d{4,9}\/[^\s<>]+)/gi,
      type: "doi" as const,
    },
  ];

  while (remaining.length > 0) {
    let earliestMatch: {
      index: number;
      length: number;
      type: string;
      content: string;
      url?: string;
    } | null = null;

    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(remaining);
      if (match && match.index >= 0) {
        if (!earliestMatch || match.index < earliestMatch.index) {
          earliestMatch = {
            index: match.index,
            length: match[0].length,
            type: pattern.type,
            content: match[1],
            url: match[2],
          };
        }
      }
    }

    if (earliestMatch) {
      if (earliestMatch.index > 0) {
        segments.push({
          type: "text",
          content: remaining.slice(0, earliestMatch.index),
        });
      }

      // If it's a markdown link with an unsafe URL (e.g. javascript:, file:),
      // disarm it by rendering as inert text rather than an active link.
      if (
        earliestMatch.type === "link" &&
        earliestMatch.url !== undefined &&
        !isSafeUrl(earliestMatch.url)
      ) {
        segments.push({
          type: "text",
          content: earliestMatch.content,
        });
        remaining = remaining.slice(earliestMatch.index + earliestMatch.length);
        continue;
      }

      const seg: InlineSegment = {
        type: earliestMatch.type as InlineSegment["type"],
        content: earliestMatch.content,
      };
      if (earliestMatch.url !== undefined) seg.url = earliestMatch.url;
      if (seg.type === "doi") {
        // Strip any doi: prefix and link to doi.org
        seg.url = `https://doi.org/${seg.content.replace(/^doi:\s*/i, "")}`;
      }
      if (seg.type === "url") {
        // The URL is its own href
        seg.url = seg.content;
      }
      segments.push(seg);
      remaining = remaining.slice(earliestMatch.index + earliestMatch.length);
    } else {
      segments.push({ type: "text", content: remaining });
      break;
    }
  }

  return segments;
}

function renderInline(segments: InlineSegment[]): ReactNode[] {
  return segments.map((seg, i) => {
    switch (seg.type) {
      case "bold":
        return (
          <strong key={i}>{renderInline(parseInline(seg.content))}</strong>
        );
      case "italic":
        return <em key={i}>{renderInline(parseInline(seg.content))}</em>;
      case "code":
        return (
          <code
            key={i}
            style={{
              background: "var(--hermes-bg-tertiary, #f4f4f4)",
              padding: "2px 4px",
              borderRadius: "3px",
              fontFamily: "monospace",
              fontSize: "0.9em",
            }}
          >
            {renderInline(parseInline(seg.content))}
          </code>
        );
      case "link":
      case "doi":
      case "url": {
        if (!seg.url || !isSafeUrl(seg.url)) {
          return <span key={i}>{seg.content}</span>;
        }
        const isAction =
          seg.url.startsWith("apply-tag:") ||
          seg.url.startsWith("add-context:") ||
          seg.url.startsWith("action:");
        return (
          <a
            key={i}
            href={seg.url}
            className={isAction ? "hermes-action-pill" : undefined}
            target={isAction ? undefined : "_blank"}
            rel={isAction ? undefined : "noopener noreferrer"}
            style={
              isAction
                ? {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "1px 8px",
                    margin: "0 2px",
                    borderRadius: "10px",
                    fontSize: "0.85em",
                    fontWeight: 500,
                    textDecoration: "none",
                    backgroundColor: "rgba(74, 144, 217, 0.12)",
                    color: "var(--hermes-accent, #4a90d9)",
                    border: "1px solid var(--hermes-accent, #4a90d9)",
                    cursor: "pointer",
                  }
                : {
                    color: "var(--hermes-accent, #4a90d9)",
                    textDecoration: "underline",
                  }
            }
          >
            {isAction ? "⚡ " : ""}
            {seg.content}
          </a>
        );
      }
      case "strikethrough":
        return <del key={i}>{seg.content}</del>;
      default:
        return <span key={i}>{seg.content}</span>;
    }
  });
}

interface Block {
  type:
    "paragraph" | "header" | "list" | "blockquote" | "code" | "hr" | "table";
  content: string | string[];
  level?: number;
  ordered?: boolean;
  headers?: string[];
  rows?: string[][];
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let currentList: { items: string[]; ordered: boolean } | null = null;
  let currentCode: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith("```")) {
      if (currentCode) {
        blocks.push({ type: "code", content: currentCode.join("\n") });
        currentCode = null;
      } else {
        currentCode = [];
      }
      continue;
    }
    if (currentCode) {
      currentCode.push(line);
      continue;
    }

    // Tables: consecutive lines starting with |
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        tableLines.push(lines[j].trim());
        j++;
      }
      if (tableLines.length >= 2) {
        // Parse header row
        const headerRow = tableLines[0];
        const headers = headerRow
          .slice(1, -1)
          .split("|")
          .map((h) => h.trim());
        // Only skip a separator row (|---|...|) if one actually exists;
        // otherwise treat row 1 as data (min1: table separator fix).
        const isSeparatorRow =
          tableLines.length >= 2 &&
          tableLines[1]
            .slice(1, -1)
            .split("|")
            .map((c) => c.trim())
            .every((c) => /^:?-{1,}:?$/.test(c));
        const dataRows = isSeparatorRow
          ? tableLines.slice(2)
          : tableLines.slice(1);
        const rows = dataRows.map((row) =>
          row
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim()),
        );
        blocks.push({
          type: "table",
          content: "",
          headers,
          rows,
        });
        i = j - 1;
        continue;
      }
    }

    // Horizontal rule
    if (
      line.trim() === "---" ||
      line.trim() === "***" ||
      line.trim() === "___"
    ) {
      if (currentList) {
        blocks.push({
          type: "list",
          content: currentList.items,
          ordered: currentList.ordered,
        });
        currentList = null;
      }
      blocks.push({ type: "hr", content: "" });
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      if (currentList) {
        blocks.push({
          type: "list",
          content: currentList.items,
          ordered: currentList.ordered,
        });
        currentList = null;
      }
      blocks.push({
        type: "header",
        content: headerMatch[2],
        level: headerMatch[1].length,
      });
      continue;
    }

    // Blockquotes
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      if (currentList) {
        blocks.push({
          type: "list",
          content: currentList.items,
          ordered: currentList.ordered,
        });
        currentList = null;
      }
      blocks.push({ type: "blockquote", content: quoteMatch[1] });
      continue;
    }

    // Lists
    const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (unorderedMatch || orderedMatch) {
      const match = unorderedMatch || orderedMatch;
      const isOrdered = !!orderedMatch;
      const item = match![2];

      if (!currentList || currentList.ordered !== isOrdered) {
        if (currentList) {
          blocks.push({
            type: "list",
            content: currentList.items,
            ordered: currentList.ordered,
          });
        }
        currentList = { items: [item], ordered: isOrdered };
      } else {
        currentList.items.push(item);
      }
      continue;
    }

    // Empty line ends lists
    if (line.trim() === "" && currentList) {
      blocks.push({
        type: "list",
        content: currentList.items,
        ordered: currentList.ordered,
      });
      currentList = null;
      continue;
    }

    // Regular paragraph
    if (line.trim() !== "") {
      if (currentList) {
        blocks.push({
          type: "list",
          content: currentList.items,
          ordered: currentList.ordered,
        });
        currentList = null;
      }
      blocks.push({ type: "paragraph", content: line });
    }
  }

  if (currentList) {
    blocks.push({
      type: "list",
      content: currentList.items,
      ordered: currentList.ordered,
    });
  }
  if (currentCode) {
    blocks.push({ type: "code", content: currentCode.join("\n") });
  }

  return blocks;
}

const headerSizes: Record<number, React.CSSProperties> = {
  1: { fontSize: "1.4em", fontWeight: 700, margin: "16px 0 8px" },
  2: {
    fontSize: "1.2em",
    fontWeight: 600,
    margin: "14px 0 6px",
    borderBottom: "1px solid var(--hermes-border, #e0e0e0)",
    paddingBottom: "4px",
  },
  3: { fontSize: "1.1em", fontWeight: 600, margin: "12px 0 6px" },
  4: { fontSize: "1em", fontWeight: 600, margin: "10px 0 4px", opacity: 0.9 },
  5: {
    fontSize: "0.95em",
    fontWeight: 600,
    margin: "8px 0 4px",
    opacity: 0.85,
  },
  6: { fontSize: "0.9em", fontWeight: 600, margin: "8px 0 4px", opacity: 0.8 },
};

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
}: {
  text: string;
}) {
  const blocks = parseBlocks(text);

  return (
    <div style={{ lineHeight: 1.5 }}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "header":
            return (
              <div key={i} style={headerSizes[block.level || 1]}>
                {renderInline(parseInline(block.content as string))}
              </div>
            );
          case "paragraph":
            return (
              <div key={i} style={{ margin: "4px 0" }}>
                {renderInline(parseInline(block.content as string))}
              </div>
            );
          case "blockquote":
            return (
              <div
                key={i}
                style={{
                  borderLeft: "3px solid var(--hermes-accent, #4a90d9)",
                  paddingLeft: "12px",
                  margin: "8px 0",
                  opacity: 0.85,
                }}
              >
                {renderInline(parseInline(block.content as string))}
              </div>
            );
          case "code":
            return (
              <pre
                key={i}
                style={{
                  background: "var(--hermes-bg-tertiary, #f4f4f4)",
                  padding: "8px",
                  borderRadius: "4px",
                  overflowX: "auto",
                  fontFamily: "monospace",
                  fontSize: "0.9em",
                  margin: "8px 0",
                }}
              >
                <code>{block.content as string}</code>
              </pre>
            );
          case "list": {
            const items = block.content as string[];
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={i}
                style={{
                  margin: "4px 0",
                  paddingLeft: "20px",
                }}
              >
                {items.map((item, j) => (
                  <li key={j}>{renderInline(parseInline(item))}</li>
                ))}
              </ListTag>
            );
          }
          case "hr":
            return (
              <hr
                key={i}
                style={{
                  border: "none",
                  borderTop: "1px solid var(--hermes-border, #e0e0e0)",
                  margin: "12px 0",
                }}
              />
            );
          case "table": {
            const headers = block.headers || [];
            const rows = block.rows || [];
            return (
              <table
                key={i}
                style={{
                  borderCollapse: "collapse",
                  width: "100%",
                  margin: "8px 0",
                  fontSize: "0.95em",
                }}
              >
                <thead>
                  <tr>
                    {headers.map((h, hi) => (
                      <th
                        key={hi}
                        style={{
                          border: "1px solid var(--hermes-border, #d0d0d0)",
                          padding: "6px 8px",
                          textAlign: "left",
                          fontWeight: 600,
                          background: "var(--hermes-bg-tertiary, #f4f4f4)",
                        }}
                      >
                        {renderInline(parseInline(h))}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          style={{
                            border: "1px solid var(--hermes-border, #d0d0d0)",
                            padding: "6px 8px",
                            textAlign: "left",
                          }}
                        >
                          {renderInline(parseInline(cell))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
});
