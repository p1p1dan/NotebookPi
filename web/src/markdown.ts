// Shared markdown-it renderer for the editor preview and the public share page.

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

export const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch { /* fall through */ }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
  },
});
const defaultLinkRender = md.renderer.rules.link_open ??
  ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx]!;
  t.attrSet('target', '_blank');
  t.attrSet('rel', 'noopener noreferrer');
  return defaultLinkRender(tokens, idx, opts, env, self);
};
