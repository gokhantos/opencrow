import { useEffect, useState } from "react";
import { LoadingState } from "../../components";
import { cn } from "../../lib/cn";
import { fetchSessionReport } from "./api";

interface ReportTabProps {
  readonly sessionId: string;
  readonly initialReport?: string;
}

// Very lightweight markdown renderer — handles headings, bold, bullets,
// horizontal rules, and code blocks. Avoids importing a full MD library.
function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      nodes.push(
        <pre
          key={key++}
          className="bg-bg border border-border rounded-lg px-4 py-3 text-xs font-mono text-foreground overflow-x-auto my-3 leading-relaxed"
        >
          {codeLines.join("\n")}
        </pre>,
      );
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={key++} className="border-border my-4" />);
      i++;
      continue;
    }

    // H1
    if (line.startsWith("# ")) {
      nodes.push(
        <h2 key={key++} className="text-lg font-bold text-strong mt-6 mb-2 tracking-tight">
          {line.slice(2)}
        </h2>,
      );
      i++;
      continue;
    }

    // H2
    if (line.startsWith("## ")) {
      nodes.push(
        <h3 key={key++} className="text-base font-semibold text-strong mt-5 mb-1.5 tracking-tight">
          {line.slice(3)}
        </h3>,
      );
      i++;
      continue;
    }

    // H3
    if (line.startsWith("### ")) {
      nodes.push(
        <h4 key={key++} className="text-sm font-semibold text-strong mt-4 mb-1">
          {line.slice(4)}
        </h4>,
      );
      i++;
      continue;
    }

    // Bullet list
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (
        i < lines.length &&
        ((lines[i] ?? "").startsWith("- ") || (lines[i] ?? "").startsWith("* "))
      ) {
        items.push((lines[i] ?? "").slice(2));
        i++;
      }
      nodes.push(
        <ul key={key++} className="list-disc list-inside text-sm text-muted leading-relaxed space-y-1 my-2 pl-2">
          {items.map((item, idx) => (
            <li key={idx}>{inlineBold(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph
    nodes.push(
      <p key={key++} className="text-sm text-muted leading-relaxed my-2">
        {inlineBold(line)}
      </p>,
    );
    i++;
  }

  return nodes;
}

/** Replace **bold** with <strong> elements. */
function inlineBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} className="text-strong font-semibold">{part.slice(2, -2)}</strong>;
        }
        return part;
      })}
    </>
  );
}

export function ReportTab({ sessionId, initialReport }: ReportTabProps) {
  const [report, setReport] = useState<string>(initialReport ?? "");
  const [loading, setLoading] = useState(!initialReport);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialReport) {
      setReport(initialReport);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchSessionReport(sessionId)
      .then(setReport)
      .catch(() => setError("Failed to load report."))
      .finally(() => setLoading(false));
  }, [sessionId, initialReport]);

  if (loading) return <LoadingState message="Loading report..." />;

  if (error) {
    return (
      <div className="py-8 px-1 text-sm text-danger">{error}</div>
    );
  }

  if (!report) {
    return (
      <div className="py-8 px-1 text-sm text-muted italic">
        No report available yet.
      </div>
    );
  }

  return (
    <div className={cn("prose-sm max-w-none")}>
      {renderMarkdown(report)}
    </div>
  );
}
