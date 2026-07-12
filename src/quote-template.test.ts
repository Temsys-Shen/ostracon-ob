import { describe, expect, test } from "vitest";
import { DEFAULT_QUOTE_TEMPLATE, renderQuoteTemplate, validateQuoteTemplate } from "./quote-template";

describe("quote template", () => {
  test("renders variables and filters from left to right", () => {
    expect(renderQuoteTemplate("{{content|trim|singleline}}", {
      content: "  first\n  second  ",
      link: null,
    })).toBe("first second");
  });

  test("quotes every line and keeps blank lines in one block", () => {
    expect(renderQuoteTemplate("{{content|blockquote}}", {
      content: "first\n\nsecond",
      link: null,
    })).toBe("> first\n>\n> second");
  });

  test("renders the link block only when a link exists", () => {
    const template = "{{content}}{{#link}}\n[MN]({{link}}){{/link}}";
    expect(renderQuoteTemplate(template, { content: "quote", link: null })).toBe("quote");
    expect(renderQuoteTemplate(template, { content: "quote", link: "mn://note" })).toBe("quote\n[MN](mn://note)");
  });

  test("renders the default template as one blockquote", () => {
    expect(renderQuoteTemplate(DEFAULT_QUOTE_TEMPLATE, {
      content: "first\nsecond",
      link: "marginnote4app://note/1",
    })).toBe("> first\n> second\n>\n> [MarginNote](marginnote4app://note/1)");
  });

  test.each([
    "{{unknown}}",
    "{{content|unknown}}",
    "{{#link}}{{#link}}{{/link}}{{/link}}",
    "{{/link}}",
    "{{#link}}missing end",
    "{{content",
  ])("rejects invalid syntax: %s", template => {
    expect(() => validateQuoteTemplate(template)).toThrow();
  });
});
