// Block-level text extraction for webfetch — new code, no DOM, no deps.
//
// The old path was three regexes: drop <script>/<style>, strip every tag,
// collapse whitespace. That leaves nav/footer/cookie-banner soup, and the
// `prompt` parameter did nothing. Full Mozilla Readability needs a DOM (jsdom
// = new dep) or a per-call headless chromium (heavy on a laptop) — both
// rejected; JS-heavy pages keep the existing answer: the Browser tools
// (playwright + inlined Readability) already do DOM-grade extraction.
//
// What this does instead, in order:
//   1. drop whole chrome blocks (script/style/nav/header/footer/aside/form/
//      noscript/svg);
//   2. prefer <main>, then <article>, when present;
//   3. keep <pre>/<code> content intact (placeholders across the tag strip);
//   4. turn block boundaries into line breaks, strip remaining tags, decode
//      the common entities, collapse horizontal whitespace;
//   5. when an objective (the tool's `prompt`) is given, score lines by token
//      overlap with it and return the top chunks IN DOCUMENT ORDER within the
//      cap; without one, plain document order (the old head-truncation shape).
//
// Naive vs a hosted objective-aware service — but local, private,
// deterministic, testable.

/** Elements whose whole subtree is page chrome, not content. */
const DROP_BLOCKS = [
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "noscript",
  "svg",
];

/** Block-level closers that end a text line (tested per tag, so no /g). */
const BLOCK_END =
  /<\/(?:p|div|li|ul|ol|section|article|main|blockquote|table|tr|dl|dt|dd|figure|figcaption|h[1-6]|td|th|details|summary)\s*>|<br\s*\/?>|<hr\s*\/?>/i;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, what: string) => {
      if (what.startsWith("#x") || what.startsWith("#")) {
        const cp = Number.parseInt(what.slice(1), what[0] === "#" && what[1] === "x" ? 16 : 10);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
          try {
            return String.fromCodePoint(cp);
          } catch {
            return whole;
          }
        }
        return whole;
      }
      return ENTITIES[what.toLowerCase()] ?? whole;
    });
}

/** Objective/objective-token tokenizer: lowercased word runs. CJK text has no
 *  spaces, so each CJK character is its own token — crude, but it makes
 *  overlap scoring work for CJK objectives instead of silently scoring 0. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    // Keep latin/digit words whole; split CJK-looking runs per character.
    if (/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+$/.test(t)) {
      for (const ch of t) out.add(ch);
    } else {
      out.add(t);
    }
  }
  return out;
}

/** Extract readable text from an HTML document.
 *  @param objective optional focus hint — when given, lines are ranked by
 *         token overlap with it and the top chunks are returned in document
 *         order; when absent, every content line in document order.
 *  @param cap hard character cap (the tool's 25 K); applied last. */
export function extractContent(html: string, opts: { objective?: string; cap?: number } = {}): string {
  const { objective, cap = 25_000 } = opts;
  let doc = html;

  // 1. Drop chrome blocks. Non-greedy to the matching close tag; an unclosed
  //    one runs to EOF, which is the safe direction (junk dropped, not kept).
  for (const tag of DROP_BLOCKS) {
    doc = doc.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
    // Anything still open after that pass is genuinely unclosed; running to
    // EOF and dropping is the safe direction (junk dropped, not kept).
    doc = doc.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), " ");
  }

  // 2. Prefer the content container when the page declares one.
  const container = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(doc) ?? /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(doc);
  if (container) doc = container[1];

  // 3. Protect <pre> blocks (with <code> inside them) across the tag strip,
  //    keeping their internal newlines and indentation.
  const pres: string[] = [];
  doc = doc.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, "");
    pres.push(text);
    return `\u0000PRE${pres.length - 1}\u0000`;
  });

  // 4. Block boundaries -> newlines, then strip tags, decode, tidy lines.
  doc = doc.replace(/<[^>]+>/g, (tag) => (BLOCK_END.test(tag) ? "\n" : " "));
  const lines = decodeEntities(doc)
    .split("\n")
    .map((line) => line.replace(/[ \t\r\u00a0]+/g, " ").trim())
    .filter((line) => line !== "");

  // 5. Objective ranking: score lines by token overlap, keep the best, and
  //    emit them in DOCUMENT order (a shuffled excerpt reads like a scam
  //    snippet site; document order reads like the page).
  let chosen = lines;
  if (objective && objective.trim() !== "") {
    const want = tokenize(objective);
    if (want.size > 0) {
      const scored = lines
        .map((line, order) => ({ line, order, score: overlap(want, tokenize(line)) }))
        .filter((l) => l.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, 12)
        .sort((a, b) => a.order - b.order);
      // Zero matches is not "show nothing": fall back to document order.
      chosen = scored.length > 0 ? scored.map((l) => l.line) : lines;
    }
  }

  // Restore the protected <pre> blocks verbatim.
  let out = chosen.join("\n\n");
  out = out.replace(/\u0000PRE(\d+)\u0000/g, (_whole, i: string) => pres[Number(i)] ?? "");
  if (out.length > cap) out = out.slice(0, cap);
  return out;
}

/** Token overlap: how many of the objective's tokens the line contains. */
function overlap(want: Set<string>, have: Set<string>): number {
  let n = 0;
  for (const t of want) if (have.has(t)) n++;
  return n;
}
