import { test, expect, describe } from "bun:test";
import { escapeHtml, markdownToTelegramHtml } from "./format";

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes less-than", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
  });

  test("escapes greater-than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  test("escapes all three in one string", () => {
    expect(escapeHtml("<script>alert('a & b')</script>")).toBe(
      "&lt;script&gt;alert('a &amp; b')&lt;/script&gt;",
    );
  });

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("markdownToTelegramHtml", () => {
  test("plain text passes through with HTML escaping", () => {
    expect(markdownToTelegramHtml("hello world")).toBe("hello world");
    expect(markdownToTelegramHtml("cats & dogs")).toBe("cats &amp; dogs");
  });

  test("bold **text**", () => {
    expect(markdownToTelegramHtml("this is **bold** text")).toBe(
      "this is <b>bold</b> text",
    );
  });

  test("italic *text*", () => {
    expect(markdownToTelegramHtml("this is *italic* text")).toBe(
      "this is <i>italic</i> text",
    );
  });

  test("bold+italic ***text***", () => {
    expect(markdownToTelegramHtml("***bold italic***")).toBe(
      "<b><i>bold italic</i></b>",
    );
  });

  test("inline code `code`", () => {
    expect(markdownToTelegramHtml("use `npm install` to install")).toBe(
      "use <code>npm install</code> to install",
    );
  });

  test("strikethrough ~~text~~", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  test("link [text](url)", () => {
    expect(markdownToTelegramHtml("[OpenCrow](https://example.com)")).toBe(
      '<a href="https://example.com">OpenCrow</a>',
    );
  });

  test("header # converts to bold", () => {
    expect(markdownToTelegramHtml("# My Header")).toBe("<b>My Header</b>");
  });

  test("deeper headers ## also convert to bold", () => {
    expect(markdownToTelegramHtml("## Section")).toBe("<b>Section</b>");
  });

  test("code block with language", () => {
    expect(markdownToTelegramHtml("```typescript\nconst x = 1;\n```")).toBe(
      '<pre><code class="language-typescript">const x = 1;</code></pre>',
    );
  });

  test("code block without language", () => {
    expect(markdownToTelegramHtml("```\nplain code\n```")).toBe(
      "<pre>plain code</pre>",
    );
  });

  test("code block escapes HTML chars in content", () => {
    expect(markdownToTelegramHtml("```\na < b && c > d\n```")).toBe(
      "<pre>a &lt; b &amp;&amp; c &gt; d</pre>",
    );
  });

  test("blockquote > text", () => {
    expect(markdownToTelegramHtml("> quoted text")).toBe(
      "<blockquote>quoted text</blockquote>",
    );
  });

  test("horizontal rule --- converts to em-dashes", () => {
    expect(markdownToTelegramHtml("---")).toBe("———");
  });

  test("unordered list - item converts to bullet", () => {
    expect(markdownToTelegramHtml("- first item")).toBe("• first item");
  });

  test("already HTML returns as-is", () => {
    const html = "<b>already bold</b> and some text";
    expect(markdownToTelegramHtml(html)).toBe(html);
  });

  test("already HTML with <pre> tag returns as-is", () => {
    const html = "<pre>code block</pre>";
    expect(markdownToTelegramHtml(html)).toBe(html);
  });

  test("multi-line combined markdown", () => {
    const md = [
      "# Title",
      "",
      "Some **bold** and *italic* text.",
      "",
      "- item one",
      "- item two",
    ].join("\n");

    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<b>Title</b>");
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("<i>italic</i>");
    expect(result).toContain("• item one");
    expect(result).toContain("• item two");
  });
});
