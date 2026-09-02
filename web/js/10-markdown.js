/* A small Markdown renderer, for lyrics.
 *
 * Deliberately not a library. Lyrics need headings, emphasis, lists, quotes and rules,
 * and every line break has to survive, which is the one thing most Markdown gets wrong
 * for song words: a verse is not a paragraph to be reflowed.
 *
 * The text is escaped before any of this runs, so the only tags in the output are the
 * ones written here. Nothing user supplied can become markup.
 */
"use strict";

J.md = function (source) {
  const text = String(source == null ? "" : source);
  const lines = text.split("\n");
  const out = [];
  let list = null;          // "ul" or "ol" while one is open
  let quoting = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quoting) { out.push("</blockquote>"); quoting = false; } };

  const inline = (raw) => J.esc(raw)
    // Code first, so nothing inside it is treated as emphasis.
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    // Only http and https, so a link cannot carry a javascript: payload.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) { closeList(); closeQuote(); out.push('<div class="md-gap"></div>'); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList(); closeQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList(); closeQuote();
      out.push("<hr>");
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      if (!quoting) { out.push("<blockquote>"); quoting = true; }
      out.push(`<p>${inline(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const want = bullet ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();

    // Every remaining line is its own line. Song words are broken where they are broken.
    out.push(`<div class="md-line">${inline(line)}</div>`);
  }
  closeList();
  closeQuote();
  return out.join("\n");
};

/* The first line, with any heading marks taken off. Matches what the server stores as
 * the sheet's name, so the two never disagree. */
J.mdTitle = function (source, fallback) {
  for (const line of String(source || "").split("\n")) {
    const stripped = line.trim().replace(/^#+\s*/, "").trim();
    if (stripped) return stripped;
  }
  return fallback || "";
};

/* Everything after the first line, so a card can show its heading separately. */
J.mdBody = function (source) {
  const lines = String(source || "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  return lines.slice(i + 1).join("\n");
};
