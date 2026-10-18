import { randomBytes } from 'node:crypto';

/**
 * Untrusted text: scanning and sanitizing what the code-fix agent shows a model, fencing it so the
 * model can tell data from instructions, and escaping what a model writes for humans.
 *
 * Threat model (docs/CODEFIX.md, "Never"). Two kinds of text reach the model that an attacker may
 * have written: what the shopping agents captured from the page (accessibility snapshots, their own
 * reasons, outcome messages) and the repository source (comments, strings, docs). Either may try to
 * change the model's task, its output format or the files it edits, to make it leak a secret, or to
 * plant code. The model's answer then reaches humans (the pull request body) and the repository (the
 * diff), so it is bounded and policed by code as well (see ./content-policy).
 *
 * Prompts are the first line of defence; this module is part of the enforcement layer. Everything
 * here is pure code, no model, and every verdict is a fact about the text:
 *
 *   scanUntrustedText      flags and exclusion for a text (binary, oversized, invisible characters,
 *                          credentials) and a tripwire for text that reads as instructions to an AI
 *   sanitizeEvidenceText   control and invisible characters out, over-long lines cut
 *   fenceUntrusted         <<<BEGIN UNTRUSTED label nonce>>> ... <<<END UNTRUSTED label nonce>>>
 *   escapeModelText        model-written text made inert and bounded for a Markdown reader
 *
 * The instruction patterns are a heuristic: a determined author can phrase an instruction that none
 * of them matches. They raise a flag for a human; they never decide anything. Exclusion rests on
 * properties that are exact (NUL bytes, size, invisible characters, credential formats).
 */

// ---- types ---------------------------------------------------------------------------------------

export type UntrustedFlag =
  | 'binary' // NUL bytes or > 5% non-printable characters
  | 'oversized' // longer than maxChars (default MAX_FILE_CHARS)
  | 'bidi_or_zero_width' // bidirectional and zero-width characters (Trojan Source), tag characters
  | 'control_chars' // C0/C1 controls other than \n, \t, \r
  | 'long_lines' // any line longer than MAX_LINE_CHARS (minified or hidden content)
  | 'instruction_like' // text that reads as instructions to an AI (INSTRUCTION_PATTERNS)
  | 'secret_like'; // credentials (SECRET_PATTERNS)

export interface UntrustedScan {
  flags: UntrustedFlag[];
  /** True when the text must not be shown to the model in full: binary, oversized, bidi_or_zero_width, secret_like */
  excluded: boolean;
  /**
   * One factual sentence per flag. Secrets are never echoed (the pattern is named, the value is not).
   * The instruction_like sentence quotes up to 60 characters of the first match, reduced to a safe
   * alphabet; it is still text from the untrusted source, so show it as data, never as an instruction.
   */
  reasons: string[];
  /** For instruction_like and secret_like: the pattern names that matched, deduplicated */
  matchedPatterns: string[];
}

export const MAX_LINE_CHARS = 2000;
export const MAX_FILE_CHARS = 200_000;

export interface NamedPattern {
  name: string;
  pattern: RegExp;
}

// ---- patterns ------------------------------------------------------------------------------------

/**
 * Instructions aimed at a model. Case-insensitive, never global (so `.test()` is stateless), and every
 * quantifier is bounded or confined to one line, so no input makes a pattern slow. Each pattern is
 * tested against one line at a time (NFKC-normalized, so full-width and mathematical letters fold to
 * ASCII). Names are short kebab-case slugs.
 */
export const INSTRUCTION_PATTERNS: readonly NamedPattern[] = Object.freeze([
  {
    name: 'ignore-instructions',
    pattern:
      /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all|any|the|your|previous|prior|above|earlier|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?)\b/i,
  },
  {
    name: 'role-reassignment',
    pattern:
      /\byou are (now|no longer)\b|\bact as\b[^.\n]{0,30}\b(an?|the)\b|\bnew (instructions?|task|role)\b[^.\n]{0,10}:/i,
  },
  {
    // Chat-template tokens, "System:" / "Assistant:" / "User:" speaker lines, "### Instruction"
    // headings. A speaker line allows only spaces and tabs before the role, so it cannot run across
    // blank lines, and it skips what reads as code (`system: PROMPT,`, `user: string;`,
    // `system: 'You are ...'`, `system: build(kind),`) so TypeScript object keys are not flagged.
    name: 'chat-markup',
    pattern:
      /<\|im_(start|end)\|>|\[\/?INST\]|<\|system\|>|^[ \t]*(system|assistant|user)[ \t]*:(?:[ \t]*$|[ \t]+(?![\w$.]+(?:\([^)\n]*\))?(?:[ \t]*[,;])?[ \t]*$)(?!['"`{[(<]))|###\s*(instruction|system|assistant)/im,
  },
  {
    name: 'model-address',
    pattern: /\b(as an ai|language model|llm|claude|gpt|assistant)\b[^.\n]{0,40}\b(you|your)\b/i,
  },
  {
    name: 'secrecy',
    pattern:
      /\b(do not|don['’]t|never)\b[^.\n]{0,30}\b(tell|report|mention|reveal|disclose|flag)\b[^.\n]{0,40}\b(user|human|reviewer|developer|anyone)\b/i,
  },
  {
    name: 'tool-coercion',
    pattern:
      /\b(run|execute|call|invoke)\b[^.\n]{0,20}\b(command|shell|curl|wget|fetch)\b|\bedit\b[^.\n]{0,20}\bpackage\.json\b/i,
  },
  {
    name: 'agentproof-address',
    pattern: /\bagentproof\b[^.\n]{0,40}\b(must|should|will|shall|always|never)\b/i,
  },
  {
    // Send something to a URL, or disclose the hidden prompt or a credential.
    name: 'exfiltration',
    pattern:
      /\b(send|post|upload|forward|transmit|email|exfiltrate|leak)\b[^\n]{0,60}\b(to|at|via)\b[^\n]{0,25}(https?:\/\/|www\.)|\b(reveal|print|repeat|disclose|leak|output)\b[^.\n]{0,30}\b(your|the)\b[^.\n]{0,20}(\b(system prompt|initial prompt|api[ _-]?keys?|secrets?|credentials?|environment variables?)\b|\.env\b)/i,
  },
  {
    // Text aimed at the reviewer model rather than the proposer.
    name: 'verdict-steering',
    pattern:
      /\b(approve|lgtm|accept)\b[^.\n]{0,20}\b(this|the|any|all)\b[^.\n]{0,20}\b(change|changes|diff|patch|pr|pull request|fix)\b|\bverdict\b[^.\n]{0,20}\b(approve|approved)\b|\b(set|return|respond with|answer)\b[^.\n]{0,20}\b(approve|approved)\b/i,
  },
]);

/**
 * Credential formats. Match the shape, never a value we know: the scan names the pattern and does
 * not echo what matched. Not global.
 */
export const SECRET_PATTERNS: readonly NamedPattern[] = Object.freeze([
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  {
    name: 'github-token',
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{60,}/,
  },
  { name: 'xai-key', pattern: /\bxai-[A-Za-z0-9]{40,}/ },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'generic-bearer',
    pattern: /\b(?:authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9._-]{30,}/i,
  },
  // Beyond the first nine: project-scoped OpenAI keys contain hyphens, and a payments store may
  // well hold a Stripe key.
  { name: 'openai-project-key', pattern: /\bsk-proj-[A-Za-z0-9_-]{32,}/ },
  { name: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
]);

// ---- characters ----------------------------------------------------------------------------------

/**
 * Characters that change what a reader sees, or hide text from one, without being visible: zero-width
 * and direction marks U+200B-U+200F, word joiner U+2060, BOM U+FEFF, embedding and override controls
 * U+202A-U+202E, isolates U+2066-U+2069 (Trojan Source). Also the Arabic letter mark U+061C, the
 * invisible operators U+2061-U+2064, the Mongolian vowel separator U+180E and the Unicode tag block
 * U+E0000-U+E007F, which renders as nothing and which some models read as ASCII. Not global.
 */
export const INVISIBLE_CHAR_PATTERN =
  /[\u{200B}-\u{200F}\u{2060}\u{FEFF}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{61C}\u{2061}-\u{2064}\u{180E}\u{E0000}-\u{E007F}]/u;
const INVISIBLE_CHARS = new RegExp(INVISIBLE_CHAR_PATTERN.source, 'gu');

/** C0 and C1 controls and DEL other than \n, \t and \r */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
/** The same plus \r: what evidence loses once CRLF has been normalized */
const STRIP_CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
/** What counts against the binary heuristic: controls, U+FFFD (undecodable bytes), lone surrogates */
const NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u{FFFD}\u{D800}-\u{DFFF}]/gu;
const NON_ASCII = /[^\x00-\x7F]/;

/** A text is binary when more than this share of its characters is non-printable */
const BINARY_NON_PRINTABLE_SHARE = 0.05;
const QUOTE_MAX_CHARS = 60;
const LISTED_CODE_POINTS = 5;

const EXCLUDING_FLAGS: ReadonlySet<UntrustedFlag> = new Set<UntrustedFlag>([
  'binary',
  'oversized',
  'bidi_or_zero_width',
  'secret_like',
]);

function countMatches(pattern: RegExp, text: string): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** How many characters match and which code points they are (sorted, at most five, then "+N more") */
function describeChars(pattern: RegExp, text: string): { count: number; list: string } {
  const seen = new Set<number>();
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    count += 1;
    seen.add(match[0].codePointAt(0) ?? 0);
  }
  const sorted = [...seen].sort((a, b) => a - b);
  const shown = sorted.slice(0, LISTED_CODE_POINTS).map(codePointLabel).join(', ');
  const more =
    sorted.length > LISTED_CODE_POINTS ? `, +${sorted.length - LISTED_CODE_POINTS} more` : '';
  return { count, list: shown + more };
}

function linesPhrase(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`;
}

/**
 * The first instruction-like match as a short quote for a human: whitespace collapsed, anything
 * outside a plain alphabet replaced by '?' (no markup, no links, no control characters), cut to 60.
 */
function safeQuote(matched: string): string {
  const plain = matched
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^A-Za-z0-9 ,'\-:;?!./]/g, '?');
  if (plain.length <= QUOTE_MAX_CHARS) return plain;
  return `${plain.slice(0, QUOTE_MAX_CHARS).trimEnd()}...`;
}

// ---- scan ----------------------------------------------------------------------------------------

/**
 * Facts about a text from outside the trust boundary. Flags are in a fixed order, reasons are
 * deterministic (no timestamps, no locale-dependent formatting), and the whole text is scanned.
 *
 * Instruction patterns and credential patterns are tested line by line, so a match never spans a line
 * break; a prompt split over two lines can slip through (that is why they only flag).
 */
export function scanUntrustedText(text: string, opts: { maxChars?: number } = {}): UntrustedScan {
  const maxChars = opts.maxChars ?? MAX_FILE_CHARS;
  const flags: UntrustedFlag[] = [];
  const reasons: string[] = [];
  const matchedPatterns: string[] = [];

  // binary
  const hasNul = text.includes('\0');
  const nonPrintable = countMatches(NON_PRINTABLE, text);
  const share = text.length === 0 ? 0 : nonPrintable / text.length;
  const mostlyNonPrintable = share > BINARY_NON_PRINTABLE_SHARE;
  if (hasNul || mostlyNonPrintable) {
    flags.push('binary');
    const parts: string[] = [];
    if (hasNul) parts.push('contains NUL bytes');
    if (mostlyNonPrintable) {
      parts.push(`${(share * 100).toFixed(1)}% of characters are non-printable`);
    }
    reasons.push(`looks like binary data (${parts.join('; ')})`);
  }

  // oversized
  if (text.length > maxChars) {
    flags.push('oversized');
    reasons.push(`${text.length} characters exceeds the limit of ${maxChars}`);
  }

  // bidi_or_zero_width
  const invisible = describeChars(INVISIBLE_CHARS, text);
  if (invisible.count > 0) {
    flags.push('bidi_or_zero_width');
    reasons.push(
      `contains ${invisible.count} bidirectional or zero-width character${invisible.count === 1 ? '' : 's'} (${invisible.list})`,
    );
  }

  // control_chars
  const controls = describeChars(CONTROL_CHARS, text);
  if (controls.count > 0) {
    flags.push('control_chars');
    reasons.push(
      `contains ${controls.count} control character${controls.count === 1 ? '' : 's'} (${controls.list})`,
    );
  }

  // Line by line: long lines, instruction-like text, credentials.
  let longLines = 0;
  let longest = 0;
  let instructionLines = 0;
  let secretLines = 0;
  const instructionHits = new Set<string>();
  const secretHits = new Set<string>();
  let firstQuote: string | undefined;
  let quoteDecided = false;

  for (const line of text.split('\n')) {
    if (line.length > MAX_LINE_CHARS) {
      longLines += 1;
      longest = Math.max(longest, line.length);
    }

    let lineHasSecret = false;
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        lineHasSecret = true;
        secretHits.add(name);
      }
    }
    if (lineHasSecret) secretLines += 1;

    const probe = NON_ASCII.test(line) ? line.normalize('NFKC') : line;
    let earliest: RegExpExecArray | undefined;
    for (const { name, pattern } of INSTRUCTION_PATTERNS) {
      const match = pattern.exec(probe);
      if (!match) continue;
      instructionHits.add(name);
      if (!earliest || match.index < earliest.index) earliest = match;
    }
    if (earliest) {
      instructionLines += 1;
      if (!quoteDecided) {
        quoteDecided = true;
        // Never quote a line that also carries a credential.
        if (!lineHasSecret) firstQuote = safeQuote(earliest[0]);
      }
    }
  }

  if (longLines > 0) {
    flags.push('long_lines');
    reasons.push(
      `${linesPhrase(longLines)} longer than ${MAX_LINE_CHARS} characters (longest ${longest})`,
    );
  }

  if (instructionLines > 0) {
    flags.push('instruction_like');
    const names = INSTRUCTION_PATTERNS.map((p) => p.name).filter((n) => instructionHits.has(n));
    matchedPatterns.push(...names);
    const quote = firstQuote ? `; first: "${firstQuote}"` : '';
    reasons.push(
      `${linesPhrase(instructionLines)} ${instructionLines === 1 ? 'matches' : 'match'} instruction-like patterns (${names.join(', ')})${quote}`,
    );
  }

  if (secretLines > 0) {
    flags.push('secret_like');
    const names = SECRET_PATTERNS.map((p) => p.name).filter((n) => secretHits.has(n));
    matchedPatterns.push(...names);
    reasons.push(
      `${linesPhrase(secretLines)} ${secretLines === 1 ? 'matches' : 'match'} credential patterns (${names.join(', ')})`,
    );
  }

  return {
    flags,
    excluded: flags.some((flag) => EXCLUDING_FLAGS.has(flag)),
    reasons,
    matchedPatterns,
  };
}

const SECRET_GLOBALS = SECRET_PATTERNS.map(
  ({ pattern }) =>
    new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
);

/** Every credential-shaped substring replaced (default '[redacted]'), for text that will be shown or stored. */
export function redactSecrets(text: string, replacement = '[redacted]'): string {
  let out = text;
  // A function, so a `$` in the replacement is never read as a substitution pattern.
  for (const pattern of SECRET_GLOBALS) out = out.replace(pattern, () => replacement);
  return out;
}

// ---- sanitize ------------------------------------------------------------------------------------

const CUT_MARKER = ' […cut]';

/** The line cut after `max` characters (a surrogate pair is kept whole) with the marker appended */
function cutLine(line: string, max: number): string {
  let end = max;
  const last = line.charCodeAt(end - 1);
  const next = line.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;
  return line.slice(0, end) + CUT_MARKER;
}

/**
 * Evidence text for the user turn: \r\n becomes \n, C0/C1 controls other than \n and \t are removed
 * (a lone \r included), the bidi and zero-width characters are removed, and each line longer than
 * maxLineChars (default MAX_LINE_CHARS) is cut and gets ' […cut]'. Ordinary text is returned
 * unchanged, and the result is a fixed point: sanitizing it again changes nothing.
 */
export function sanitizeEvidenceText(text: string, opts: { maxLineChars?: number } = {}): string {
  const requested = opts.maxLineChars;
  const max =
    requested !== undefined && Number.isFinite(requested)
      ? Math.max(1, Math.floor(requested))
      : MAX_LINE_CHARS;
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(STRIP_CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '');
  if (cleaned.length <= max) return cleaned;
  return cleaned
    .split('\n')
    .map((line) => (line.length > max ? cutLine(line, max) : line))
    .join('\n');
}

// ---- fences --------------------------------------------------------------------------------------

const NONCE_PATTERN = /^[0-9a-f]{16}$/;

/** 16 lowercase hex characters from crypto.randomBytes. One per fix is enough: it only has to be unguessable. */
export function newUntrustedNonce(): string {
  return randomBytes(8).toString('hex');
}

/** What a fence label may look like: a path-like token, so it cannot close or confuse a marker */
export const UNTRUSTED_LABEL = /^[a-z0-9][a-z0-9_.\/@-]{0,160}$/i;

/** The opening marker for a label and nonce */
export function untrustedBeginMarker(label: string, nonce: string): string {
  return `<<<BEGIN UNTRUSTED ${label} ${nonce}>>>`;
}

/** The closing marker string for a label and nonce (for tests and the system prompt text). */
export function untrustedEndMarker(label: string, nonce: string): string {
  return `<<<END UNTRUSTED ${label} ${nonce}>>>`;
}

/**
 * `<<<BEGIN UNTRUSTED ${label} ${nonce}>>>\n${text}\n<<<END UNTRUSTED ${label} ${nonce}>>>`
 *
 * The content is NOT modified: source must stay verbatim so the model's search strings match. The
 * nonce is chosen after the content exists and is unpredictable to it, so the content cannot forge
 * the END marker. Throws when the label fails UNTRUSTED_LABEL, when the nonce is not 16 lowercase hex
 * characters, or when the text already contains the exact END marker.
 */
export function fenceUntrusted(label: string, text: string, nonce: string): string {
  if (!UNTRUSTED_LABEL.test(label)) {
    throw new Error(`Invalid untrusted label ${JSON.stringify(label.slice(0, 80))}`);
  }
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('Invalid untrusted nonce: expected 16 lowercase hex characters');
  }
  const end = untrustedEndMarker(label, nonce);
  if (text.includes(end)) {
    throw new Error(`Untrusted text for ${label} contains the closing marker of its own fence`);
  }
  return `${untrustedBeginMarker(label, nonce)}\n${text}\n${end}`;
}

// ---- model text for humans -----------------------------------------------------------------------

/** A trailing half of an entity this module wrote (&, &a, &am, &amp, &l, &lt, &g, &gt) */
const PARTIAL_ENTITY = /&[a-z]{0,3}$/;
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * Model-written text destined for humans (PR body, headlines): & < > become HTML entities, \r is
 * dropped, the bidi and zero-width characters and control characters (other than \n and \t) are
 * removed, 3+ newlines collapse to 2, the result is trimmed and cut to at most maxChars characters
 * (entities counted) with '…' as the last one. A Markdown renderer shows the entities as the literal
 * characters, so nothing can inject HTML or hide text. Links, images and @mentions are not touched.
 */
export function escapeModelText(text: string, maxChars: number): string {
  if (!(maxChars > 0)) return '';
  const escaped = text
    .replace(/\r/g, '')
    .replace(STRIP_CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // A pull request body notifies every @mention and renders links and images; model text
    // must do none of that.
    .replace(/@(?=[A-Za-z0-9_])/g, '(at)')
    .replace(/!\[/g, '! [')
    .replace(/\]\(/g, '] (')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (escaped.length <= maxChars) return escaped;
  const head = escaped
    .slice(0, Math.max(0, Math.floor(maxChars) - 1))
    .replace(LONE_HIGH_SURROGATE, '')
    .replace(PARTIAL_ENTITY, '')
    .trimEnd();
  return `${head}…`;
}
