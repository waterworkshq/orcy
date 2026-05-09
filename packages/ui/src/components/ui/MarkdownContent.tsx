import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  if (!content) return null;
  return (
    <div className={`prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }: any) => {
            if (typeof href === 'string' && href.startsWith('mention://')) {
              const [, mentionedType] = href.replace('mention://', '').split('/');
              return (
                <span
                  className={`rounded px-1 py-0.5 font-medium ${mentionedType === 'agent' ? 'bg-[var(--agent-purple)]/15 text-[var(--badge-active-text)]' : 'bg-[var(--agent-blue)]/15 text-[var(--badge-active-text)]'}`}
                  {...props}
                >
                  {children}
                </span>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400" {...props}>
                {children}
              </a>
            );
          },
          code: ({ inline, children, ...props }: any) =>
            inline ? (
              <code className="rounded bg-secondary px-1 py-0.5 text-xs font-mono" {...props}>{children}</code>
            ) : (
              <code className="block rounded bg-secondary p-2 text-xs font-mono overflow-x-auto" {...props}>{children}</code>
            ),
          pre: ({ children }) => <pre className="rounded bg-secondary p-3 overflow-x-auto">{children}</pre>,
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-muted pl-3 italic text-muted-foreground">{children}</blockquote>,
          h1: ({ children }) => <h1 className="text-base font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          table: ({ children }) => <table className="w-full text-xs border-collapse">{children}</table>,
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold bg-secondary">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
