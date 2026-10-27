// A small, strict parser for the YAML subset that review-policy.yml uses.
//
// Supported: block mappings, block sequences of scalars or flow
// collections, flow sequences and flow mappings (which may span lines),
// single- and double-quoted strings, plain scalars, integers, booleans,
// null, and comments. Anything else (anchors, aliases, tags, block
// scalars, multiple documents, tabs, nested block mappings inside
// sequences) is rejected with an error rather than guessed at, so a
// config the parser does not fully understand fails closed.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
  }
}

const RESERVED_START = new Set(['&', '*', '!', '|', '>', '%', '@', '`']);

// stripComment removes a trailing comment that is outside quotes. A '#'
// starts a comment only at the start of the line or after whitespace.
function stripComment(text, lineNo) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || text[i - 1] === ' ')) {
      return text.slice(0, i);
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', lineNo);
  return text;
}

function flowDepthDelta(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth;
}

// Cursor over a single scalar or flow value.
class FlowParser {
  constructor(text, lineNo) {
    this.s = text;
    this.i = 0;
    this.line = lineNo;
  }

  fail(msg) {
    throw new YamlError(msg, this.line);
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  peek() {
    return this.s[this.i];
  }

  done() {
    this.ws();
    return this.i >= this.s.length;
  }

  value(inFlow) {
    this.ws();
    const c = this.peek();
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    if (c === '"') return this.dquote();
    if (c === "'") return this.squote();
    return this.plain(inFlow, false);
  }

  seq() {
    this.i++;
    const out = [];
    this.ws();
    if (this.peek() === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value(true));
      this.ws();
      const c = this.peek();
      this.i++;
      if (c === ']') return out;
      if (c !== ',') this.fail("expected ',' or ']' in flow sequence");
      this.ws();
      // Allow a trailing comma.
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
    }
  }

  map() {
    this.i++;
    const out = Object.create(null);
    this.ws();
    if (this.peek() === '}') {
      this.i++;
      return { ...out };
    }
    for (;;) {
      this.ws();
      const c = this.peek();
      let key;
      if (c === '"') key = this.dquote();
      else if (c === "'") key = this.squote();
      else key = this.plain(true, true);
      if (typeof key !== 'string') key = String(key);
      this.ws();
      if (this.peek() !== ':') this.fail(`expected ':' after key "${key}"`);
      this.i++;
      if (Object.hasOwn(out, key)) this.fail(`duplicate key "${key}"`);
      out[key] = this.value(true);
      this.ws();
      const d = this.peek();
      this.i++;
      if (d === '}') return { ...out };
      if (d !== ',') this.fail("expected ',' or '}' in flow mapping");
      this.ws();
      if (this.peek() === '}') {
        this.i++;
        return { ...out };
      }
    }
  }

  dquote() {
    this.i++;
    let out = '';
    const esc = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0' };
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.s[this.i++];
        if (!(e in esc)) this.fail(`unsupported escape "\\${e}"`);
        out += esc[e];
      } else {
        out += c;
      }
    }
    this.fail('unterminated double-quoted string');
  }

  squote() {
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === "'") {
        if (this.s[this.i] === "'") {
          out += "'";
          this.i++;
        } else {
          return out;
        }
      } else {
        out += c;
      }
    }
    this.fail('unterminated single-quoted string');
  }

  plain(inFlow, isKey) {
    const start = this.i;
    const c = this.peek();
    if (c === undefined) return null;
    if (RESERVED_START.has(c)) {
      this.fail(`unsupported YAML syntax starting with "${c}" (quote the value)`);
    }
    if (c === ']' || c === '}' || c === ',') {
      if (inFlow) return null;
      this.fail(`unexpected "${c}"`);
    }
    if (c === '-' && (this.s[this.i + 1] === ' ' || this.s[this.i + 1] === undefined)) {
      this.fail('unexpected sequence item (block sequences must be on their own lines)');
    }
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      const next = this.s[this.i + 1];
      if (inFlow && (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{')) break;
      if (ch === ':' && (next === undefined || next === ' ' || (inFlow && (next === ',' || next === '}' || next === ']')))) {
        if (isKey) break;
        this.fail('unexpected ": " in a plain value (quote the value)');
      }
      this.i++;
    }
    return scalar(this.s.slice(start, this.i).trim());
  }
}

function scalar(text) {
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function parseInline(text, lineNo) {
  const p = new FlowParser(text, lineNo);
  const v = p.value(false);
  if (!p.done()) p.fail(`unexpected trailing text "${p.s.slice(p.i).trim()}"`);
  return v;
}

function parseKey(text, lineNo) {
  const t = text.trim();
  if (t === '') throw new YamlError('empty mapping key', lineNo);
  if (t[0] === '"' || t[0] === "'") {
    const p = new FlowParser(t, lineNo);
    const k = p.value(false);
    if (!p.done()) p.fail('unexpected text after quoted key');
    return k;
  }
  if (RESERVED_START.has(t[0]) || '[]{},?'.includes(t[0])) {
    throw new YamlError(`unsupported mapping key "${t}"`, lineNo);
  }
  return t;
}

// findKeyColon returns the index of the ':' that ends a mapping key, or -1.
function findKeyColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) {
      quote = c;
      continue;
    }
    if ((c === '[' || c === '{') && i === 0) return -1;
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

// tokenize turns the text into logical lines, joining multi-line flow
// collections into one line.
function tokenize(src) {
  const raw = src.replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (let n = 0; n < raw.length; n++) {
    const lineNo = n + 1;
    let text = raw[n];
    const indentMatch = /^[ \t]*/.exec(text)[0];
    if (indentMatch.includes('\t')) throw new YamlError('tabs are not allowed for indentation', lineNo);
    text = stripComment(text, lineNo).replace(/\s+$/, '');
    if (text.trim() === '') continue;
    if (lines.length === 0 && text === '---') continue;
    if (/^(---|\.\.\.)(\s|$)/.test(text)) throw new YamlError('multiple documents are not supported', lineNo);
    let depth = flowDepthDelta(text);
    while (depth > 0) {
      n++;
      if (n >= raw.length) throw new YamlError('unterminated flow collection', lineNo);
      const more = stripComment(raw[n], n + 1).trim();
      text += ' ' + more;
      depth += flowDepthDelta(more);
    }
    if (depth < 0) throw new YamlError('unbalanced brackets', lineNo);
    lines.push({ indent: indentMatch.length, text: text.trim(), lineNo });
  }
  return lines;
}

export function parseYaml(src) {
  if (typeof src !== 'string') throw new YamlError('input must be a string');
  const lines = tokenize(src);
  if (lines.length === 0) return null;
  let pos = 0;

  function parseBlock(indent) {
    const first = lines[pos];
    if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(first.indent);
    return parseMap(indent);
  }

  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.lineNo);
      if (!(l.text === '-' || l.text.startsWith('- '))) break;
      const rest = l.text.slice(1).trim();
      if (rest === '') throw new YamlError('empty or nested block sequence items are not supported', l.lineNo);
      if (findKeyColon(rest) !== -1) {
        throw new YamlError('mappings inside block sequences are not supported', l.lineNo);
      }
      out.push(parseInline(rest, l.lineNo));
      pos++;
    }
    return out;
  }

  function parseMap(indent) {
    const out = Object.create(null);
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.lineNo);
      if (l.text === '-' || l.text.startsWith('- ')) {
        throw new YamlError('unexpected sequence item in a mapping', l.lineNo);
      }
      const colon = findKeyColon(l.text);
      if (colon === -1) throw new YamlError(`expected "key: value", got "${l.text}"`, l.lineNo);
      const key = parseKey(l.text.slice(0, colon), l.lineNo);
      if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, l.lineNo);
      const rest = l.text.slice(colon + 1).trim();
      pos++;
      if (rest !== '') {
        out[key] = parseInline(rest, l.lineNo);
        continue;
      }
      const next = lines[pos];
      const isSeqItem = next && (next.text === '-' || next.text.startsWith('- '));
      if (next && (next.indent > indent || (next.indent === indent && isSeqItem))) {
        out[key] = isSeqItem ? parseSeq(next.indent) : parseMap(next.indent);
      } else {
        out[key] = null;
      }
    }
    return { ...out };
  }

  const root = parseBlock(lines[0].indent);
  if (pos < lines.length) {
    throw new YamlError('unexpected content (check indentation)', lines[pos].lineNo);
  }
  return root;
}
