const DEFAULT_QUOTE_TEMPLATE = `{{content|trim|blockquote}}
{{#link}}>
> [MarginNote]({{link}}){{/link}}`;

type QuoteTemplateContext = {
  content: string;
  link: string | null;
  heading?: string;
  title?: string;
};

type QuoteFilter = (value: string) => string;

const FILTERS: Record<string, QuoteFilter> = {
  trim: value => value.trim(),
  singleline: value => value.replace(/\s+/g, " "),
    blockquote: value => value
    .split("\n")
    .map(line => line ? `> ${line}` : ">")
    .join("\n"),
};

function renderVariable(expression: string, context: QuoteTemplateContext): string {
  const parts = expression.split("|").map(part => part.trim());
  const variable = parts.shift();
  if (variable !== "content" && variable !== "link" && variable !== "heading" && variable !== "title") {
    throw new Error(`未知模板变量: ${variable || expression}`);
  }

  let value = variable === "content" ? context.content : variable === "heading" ? context.heading || "" : variable === "title" ? context.title || "" : context.link || "";
  for (const filterName of parts) {
    const filter = FILTERS[filterName];
    if (filter) value = filter(value);
    else throw new Error(`未知模板过滤器: ${filterName}`);
  }
  return value;
}

function renderQuoteTemplate(template: string, context: QuoteTemplateContext): string {
  if (typeof template !== "string") throw new Error("引用模板必须是字符串");

  const tokenPattern = /{{([\s\S]*?)}}/g;
  let cursor = 0;
  let insideLinkBlock = false;
  let output = "";
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(template)) !== null) {
    if (!insideLinkBlock || context.link) output += template.slice(cursor, match.index);
    const expression = match[1].trim();

    if (expression === "#link") {
      if (insideLinkBlock) throw new Error("引用模板不支持嵌套条件块");
      insideLinkBlock = true;
    } else if (expression === "/link") {
      if (!insideLinkBlock) throw new Error("引用模板存在多余的{{/link}}");
      insideLinkBlock = false;
    } else if (expression.startsWith("#") || expression.startsWith("/")) {
      throw new Error(`未知模板条件块: ${expression}`);
    } else if (!insideLinkBlock || context.link) {
      output += renderVariable(expression, context);
    }
    cursor = tokenPattern.lastIndex;
  }

  if (insideLinkBlock) throw new Error("引用模板缺少{{/link}}");
  if (template.slice(cursor).includes("{{") || template.slice(cursor).includes("}}")) {
    throw new Error("引用模板包含未闭合语法");
  }
  output += template.slice(cursor);
  return output;
}

function validateQuoteTemplate(template: string): void {
  renderQuoteTemplate(template, { content: "第一行\n第二行", link: "marginnote4app://note/example" });
  renderQuoteTemplate(template, { content: "内容", link: null });
}

export { DEFAULT_QUOTE_TEMPLATE, renderQuoteTemplate, validateQuoteTemplate };
export type { QuoteTemplateContext };
