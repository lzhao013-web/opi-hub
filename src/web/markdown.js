import markdownit from "./vendor/markdown-it.js";

const markdown = markdownit({ html: false, breaks: true, linkify: false, typographer: false });
const validateLink = markdown.validateLink;
markdown.validateLink = (url) => validateLink(url) && /^(https?:|mailto:)/i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index].attrSet("target", "_blank"); tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
for (const type of ["th_open", "td_open"]) markdown.renderer.rules[type] = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index]; const alignment = token.attrGet("style");
  if (alignment) { token.attrs.splice(token.attrIndex("style"), 1); token.attrSet("class", `md-align-${alignment.slice("text-align:".length)}`); }
  return renderer.renderToken(tokens, index, options);
};
// 图片只显示替代文字，避免模型回复自动请求外部资源。
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(`[图片：${tokens[index].content || "未命名"}]`);

/** 只把关闭原始 HTML、受限链接和图片规则的解析结果交给 HTML 显示入口。 */
export function renderMarkdown(text) { return markdown.render(text); }
