/**
 * Convert Claude's markdown output to Telegram-compatible HTML.
 *
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <blockquote>,
 * <a href="...">, <tg-spoiler>.
 *
 * Claude outputs standard markdown: **bold**, *italic*, `code`,
 * ```code blocks```, ## headers, - lists, [links](url), etc.
 */

/** Escape HTML special characters in raw text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert markdown to Telegram HTML.
 *
 * Handles: code blocks, inline code, bold, italic, strikethrough,
 * headers (→ bold), links, blockquotes, and unordered/ordered lists.
 */
/**
 * Detect if text is already Telegram-compatible HTML (contains common HTML tags
 * that aren't the result of markdown conversion).
 */
function isAlreadyHtml(text: string): boolean {
  // Check for common HTML tags that agents might produce directly
  return /<\/?(?:b|i|u|s|a|pre|code|blockquote|tg-spoiler)[\s>]/i.test(text);
}

export function markdownToTelegramHtml(md: string): string {
  // If input already contains HTML tags, return as-is (agent produced HTML directly)
  if (isAlreadyHtml(md)) {
    return md;
  }

  const lines = md.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code blocks: ```lang\n...\n```
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing ```
      const code = escapeHtml(codeLines.join("\n"));
      if (lang) {
        result.push(`<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`);
      } else {
        result.push(`<pre>${code}</pre>`);
      }
      continue;
    }

    // Blockquote lines: > text
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (!cur.startsWith("> ") && cur !== ">") break;
        quoteLines.push(cur.slice(2));
        i++;
      }
      const quoteContent = quoteLines.map((l) => formatInline(escapeHtml(l))).join("\n");
      result.push(`<blockquote>${quoteContent}</blockquote>`);
      continue;
    }

    // Headers: # → bold
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const content = formatInline(escapeHtml(headerMatch[2] ?? ""));
      result.push(`<b>${content}</b>`);
      i++;
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (/^[-*_]{3,}\s*$/.test(line)) {
      result.push("———");
      i++;
      continue;
    }

    // Regular line — escape and format inline elements
    result.push(formatInline(escapeHtml(line)));
    i++;
  }

  return result.join("\n");
}

/**
 * Format inline markdown elements within already-escaped HTML text.
 *
 * Order matters — process patterns from most specific to least specific
 * to avoid conflicts (e.g. ** before *).
 */
function formatInline(text: string): string {
  let out = text;

  // Inline code: `text` (must come first to protect code content)
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Links: [text](url) — url was escaped, unescape &amp; back for href
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label: string, url: string) => {
      const cleanUrl = url.replace(/&amp;/g, "&");
      return `<a href="${cleanUrl}">${label}</a>`;
    },
  );

  // Bold+italic: ***text*** or ___text___
  out = out.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");
  out = out.replace(/_{3}(.+?)_{3}/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  out = out.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");
  out = out.replace(/_{2}(.+?)_{2}/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words like some_var_name)
  out = out.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<i>$1</i>");
  out = out.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Unordered list items: - text or * text → bullet
  out = out.replace(/^(\s*)[-*]\s+/, "$1• ");

  return out;
}
