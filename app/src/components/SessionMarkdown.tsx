import Markdown, {type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import "../styles/session-markdown.css";

function safeLink(url: string): string | undefined {
  // Descriptions are untrusted agent output. No app-relative actions or custom schemes.
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.username || parsed.password ? undefined : parsed.href;
  } catch { return undefined; }
}

const components: Components = {
  a: ({href, children}) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
    : <span>{children}</span>,
  // Even an innocent-looking remote image leaks that the owner read private content.
  img: ({alt}) => <span>{alt || "[image omitted]"}</span>,
};

export function SessionMarkdown({text, compact = true}: {text: string; compact?: boolean}) {
  return <div className={`session-markdown${compact ? " is-compact" : ""}`}>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeLink}
      allowedElements={["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "hr", "table", "thead", "tbody", "tr", "th", "td"]}
      components={components}>{text.slice(0, 8192)}</Markdown>
  </div>;
}
