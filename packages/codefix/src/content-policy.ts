import type { CodeFixCheck } from '@agentproof/shared';
import { INVISIBLE_CHAR_PATTERN, SECRET_PATTERNS, redactSecrets } from './untrusted';

/**
 * `content_policy`: a code-written check over the diff the model's edits produced.
 *
 * The model's output reaches the repository, so what a fix may add is policed by code, not by the
 * prompt. A fix for "a machine cannot perceive this control" has no business calling the network,
 * running dynamic code, touching the process or the filesystem, importing a new package, adding
 * scripts or credentials, hiding things from shoppers, or removing a payment guard. Added lines are
 * tested against the rules below; two rules look at removed lines.
 *
 * This is a tripwire, not a sandbox. It matches the obvious payloads, one line at a time, so a
 * determined author can split or encode one. The other layers decide the rest: the scope checks
 * bound which files and how much, the typecheck and the optional rematch run the result, the reviewer
 * model reads the diff, and a human merges the draft pull request. Every violation is a fact (rule,
 * file, direction, excerpt); the check fails when there is any, and the model is told which rules
 * fired so it may try again.
 *
 * Headers and context lines are never matched, and a diff is read hunk by hunk (by the line counts in
 * each `@@` header), so a content line that happens to start with `++` or `--` is still an added or
 * removed line and not mistaken for a file header. A line is also split where JavaScript would break
 * it (a lone CR, U+2028, U+2029) and tested a second time as its ASCII escapes and character
 * references spell it, so neither a line break nor `&#106;avascript:` hides a rule's keyword.
 */

export interface ContentRule {
  rule: string;
  direction: 'added' | 'removed';
  /** Tested against the line without its leading '+' or '-'. Never global. */
  pattern: RegExp;
  why: string;
  /**
   * When set, the rule fires only if this also matches the line itself, any other line of the same
   * hunk (added, removed or context) or the file path. Used where the telling words sit on a
   * neighbouring line.
   */
  context?: RegExp;
}

/** An XML namespace name such as xmlns="http://www.w3.org/2000/svg" identifies a vocabulary and is never fetched, so it is not a host. */
const XML_NAMESPACE = String.raw`www\.w3\.org\/(?:1999|2000)\/(?:svg|xlink|xhtml)\b`;
/**
 * A loopback host, then an optional port, then the end of the authority: a path, query, fragment,
 * delimiter or the end of the line. `http://localhost.evil.test` and `http://localhost@evil.test`
 * are therefore external.
 */
const LOOPBACK_AUTHORITY = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(?:\d{1,5}|\$\{[^}]*\}))?(?:[\/?#\s'"\`<>)\],;}]|$)`;

const EXTERNAL_URL = new RegExp(
  [
    // A URL whose host is not loopback or an XML namespace
    String.raw`(?:https?|wss?|ftp):\/\/(?!${XML_NAMESPACE}|${LOOPBACK_AUTHORITY})[^\s'"\`<>)]+`,
    // Protocol-relative references in attributes, CSS url() and @import
    String.raw`\b(?:src|href|action|srcset|formaction|poster|data)\s*=\s*["']?\/\/[^"'\s>]+`,
    String.raw`\burl\(\s*["']?\/\/`,
    String.raw`@import\s+["']?\/\/`,
  ].join('|'),
  'i',
);

const NETWORK_API =
  /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+(?:WebSocket|EventSource)\b|\bnew\s+Image\s*\(|\bsendBeacon\b|\b(?:https?|http2|net|tls)\.(?:request|get|connect|createConnection)\s*\(|\bundici\b|\baxios\b|\b(?:window\.open|location\.(?:assign|replace))\s*\(|(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns)['"]/;

const DYNAMIC_CODE =
  /\beval\b|\bnew\s+Function\b|\bFunction\s*\(|\bvm\.(?:run\w*|compile\w*|Script)\b|\bnew\s+vm\.|\b(?:setTimeout|setInterval|setImmediate)\s*\(\s*['"`]|\bimport\s*\(|\.constructor\s*\(\s*['"`]|\bWebAssembly\b|\bimportScripts\b|\bnew\s+Worker\b/;

const PROCESS_AND_FS =
  /child_process|\b(?:execSync|execFile|execFileSync|spawnSync)\b|\b(?:spawn|fork)\s*\(|\bexec\s*\(\s*['"`]|\bprocess\.(?:env|exit|argv|kill|chdir|binding|dlopen|abort)\b|\bnode:(?:fs|os|worker_threads|cluster)\b|(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"](?:fs|os|worker_threads|cluster)(?:\/[^'"]*)?['"]|\b(?:read|write|append|copy)File(?:Sync)?\b|\b(?:rmSync|unlinkSync|rmdirSync|mkdirSync|renameSync|readdirSync|createReadStream|createWriteStream)\b/;

const SCRIPT_INJECTION =
  /<script\b|javascript:|vbscript:|\bdata:\s*(?:text\/(?:html|javascript)|application\/(?:x-)?javascript)|document\.cookie|\b(?:inner|outer)HTML\s*=(?!=)|insertAdjacentHTML|document\.write(?:ln)?\s*\(|<(?:iframe|object|embed)\b|\bsrcdoc\s*=/i;

const OBFUSCATION =
  /\batob\s*\(|\bunescape\s*\(|Buffer\.from\([^)]{0,200}['"](?:base64|hex)['"]|String\.(?:fromCharCode|fromCodePoint)\s*\(|(?:\\x[0-9a-fA-F]{2}){4,}|(?:\\u[0-9a-fA-F]{4}){4,}|(?:\\u\{[0-9a-fA-F]+\}){3,}|[A-Za-z0-9+/]{120,}={0,2}/;

/** A bare specifier: not relative ('./', '../'), not absolute, not a node: built-in */
const BARE = String.raw`['"](?![./]|node:)[^'"]+['"]`;
const NEW_PACKAGE_IMPORT = new RegExp(
  [
    String.raw`^\s*(?:import|export)\b[^'"]*\bfrom\s+${BARE}`,
    String.raw`^\s*import\s+${BARE}`,
    // The last line of a multi-line import: `} from 'package';`
    String.raw`^\s*\}\s*from\s+${BARE}`,
    String.raw`\brequire\s*\(\s*${BARE}\s*\)`,
  ].join('|'),
);

const HUMAN_VISIBILITY =
  /\bdisplay\s*[:=]\s*['"]?none\b|\bvisibility\s*[:=]\s*['"]?hidden\b|\bopacity\s*[:=]\s*['"]?0(?![.\d])|\bpointer-?events\s*[:=]\s*['"]?none\b/i;

const PAYMENT_GUARD =
  /\/checkout\/place-order|paymentAuthorized|isPaymentControl|place[-_ ]?order|payment[-_ ]?(?:guard|policy)/i;

/**
 * Every rule, in the order violations are reported for a line: the added-line rules (with one
 * `secret-like:<name>` rule per credential pattern after `invisible-chars`), then the two removed-line
 * rules.
 */
export const CONTENT_RULES: readonly ContentRule[] = Object.freeze([
  {
    rule: 'external-url',
    direction: 'added',
    pattern: EXTERNAL_URL,
    why: 'the fix would reference an external host',
  },
  {
    rule: 'network-api',
    direction: 'added',
    pattern: NETWORK_API,
    why: 'the fix would add a network call',
  },
  {
    rule: 'dynamic-code',
    direction: 'added',
    pattern: DYNAMIC_CODE,
    why: 'the fix would execute dynamic code',
  },
  {
    rule: 'process-and-fs',
    direction: 'added',
    pattern: PROCESS_AND_FS,
    why: 'the fix would touch the process, environment or filesystem',
  },
  {
    rule: 'script-injection',
    direction: 'added',
    pattern: SCRIPT_INJECTION,
    why: 'the fix would inject scripts or read cookies',
  },
  {
    rule: 'obfuscation',
    direction: 'added',
    pattern: OBFUSCATION,
    why: 'the fix contains encoded or obfuscated content',
  },
  {
    rule: 'invisible-chars',
    direction: 'added',
    pattern: INVISIBLE_CHAR_PATTERN,
    why: 'the fix contains invisible or bidirectional control characters',
  },
  ...SECRET_PATTERNS.map(({ name, pattern }): ContentRule => ({
    rule: `secret-like:${name}`,
    direction: 'added',
    pattern,
    why: 'the fix would add something that looks like a credential',
  })),
  {
    rule: 'new-package-import',
    direction: 'added',
    pattern: NEW_PACKAGE_IMPORT,
    why: 'the fix imports a package that was not imported before',
  },
  {
    rule: 'human-visibility',
    direction: 'added',
    pattern: HUMAN_VISIBILITY,
    why: 'the fix hides something from sighted shoppers instead of exposing it to machines',
  },
  {
    rule: 'payment-guard-removed',
    direction: 'removed',
    pattern: PAYMENT_GUARD,
    why: 'the fix removes a payment guard',
  },
  {
    // `.code(403)` often sits on a line of its own, below the route line that names the checkout, so
    // the telling word may be anywhere in the hunk. A 403 in a hunk about nothing payment-related is
    // not flagged.
    rule: '403-removed',
    direction: 'removed',
    pattern: /\b403\b|\bforbidden\b/i,
    context: /checkout|order|pay/i,
    why: 'the fix removes a 403 response',
  },
]);

// ---- reading a diff ----------------------------------------------------------------------------

interface DiffLine {
  kind: 'added' | 'removed' | 'context';
  /** Without the leading '+', '-' or ' ' */
  text: string;
}

interface Hunk {
  path: string;
  lines: DiffLine[];
}

const UNKNOWN_PATH = '(unknown file)';
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** The path in a `--- a/<path>` or `+++ b/<path>` header; undefined for /dev/null */
function headerPath(rest: string, prefix: 'a/' | 'b/'): string | undefined {
  const tab = rest.indexOf('\t');
  let path = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === '/dev/null' || path === '') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Split a unified diff into hunks of classified lines. Inside a hunk the counts in its `@@` header
 * say how many old and new lines follow, and every line there is classified by its first character,
 * so `+++ x` in the body is an added line `++ x`. Outside a hunk `---`/`+++` lines are file headers
 * (they set the current path) and are never content. A '+', '-' or ' ' line outside any hunk (a
 * hand-written or truncated diff) is still read as content, so nothing hides by omitting a header.
 */
function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let path = UNKNOWN_PATH;
  let oldPath: string | undefined;
  let current: Hunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;

  const push = (kind: DiffLine['kind'], text: string): void => {
    if (!current) {
      current = { path, lines: [] };
      hunks.push(current);
    }
    current.lines.push({ kind, text });
  };

  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const head = line.charAt(0);
      if (head === '+') {
        newLeft -= 1;
        push('added', line.slice(1));
        continue;
      }
      if (head === '-') {
        oldLeft -= 1;
        push('removed', line.slice(1));
        continue;
      }
      if (head === ' ' || line === '') {
        oldLeft -= 1;
        newLeft -= 1;
        push('context', line.slice(1));
        continue;
      }
      if (head === '\\') continue; // "\ No newline at end of file"
      // The header promised more lines than there are: malformed, read the line as a header.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith('@@')) {
      current = undefined;
      const header = HUNK_HEADER.exec(line);
      if (header) {
        oldLeft = header[1] === undefined ? 1 : Number(header[1]);
        newLeft = header[2] === undefined ? 1 : Number(header[2]);
        current = { path, lines: [] };
        hunks.push(current);
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = headerPath(line.slice(4), 'a/');
      path = oldPath ?? UNKNOWN_PATH;
      current = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = headerPath(line.slice(4), 'b/') ?? oldPath ?? UNKNOWN_PATH;
      current = undefined;
      continue;
    }
    if (line.startsWith('diff ')) {
      oldPath = undefined;
      path = UNKNOWN_PATH;
      current = undefined;
      continue;
    }

    // Outside a hunk: content lines of a diff without usable headers; everything else is metadata.
    if (line.startsWith('+') && !line.startsWith('+++')) push('added', line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) push('removed', line.slice(1));
    else if (line.startsWith(' ')) push('context', line.slice(1));
  }
  return hunks;
}

// ---- violations ----------------------------------------------------------------------------------

export interface PolicyViolation {
  rule: string;
  path: string;
  direction: 'added' | 'removed';
  /**
   * Excerpt of the line, trimmed, at most 160 characters; credentials redacted, invisible characters
   * shown as [U+XXXX]. It is the model's own text: escape it before putting it in Markdown or HTML
   * (checkContentPolicy does so for its detail).
   */
  line: string;
  why: string;
}

const EXCERPT_MAX_CHARS = 160;
const PATH_MAX_CHARS = 200;
const DETAIL_MAX_CHARS = 2000;

const DISPLAY_UNSAFE = new RegExp(
  `${INVISIBLE_CHAR_PATTERN.source}|[\\x00-\\x08\\x0B-\\x1F\\x7F-\\x9F]`,
  'gu',
);

/** Text that is safe to show: tabs as spaces, a trailing \r gone, controls and invisibles named, not rendered */
function displaySafe(text: string): string {
  return text
    .replace(/\t/g, ' ')
    .replace(/\r+$/, '')
    .replace(
      DISPLAY_UNSAFE,
      (ch) => `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`,
    );
}

function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function excerptOf(line: string): string {
  return cutTo(displaySafe(redactSecrets(line)).trim(), EXCERPT_MAX_CHARS);
}

interface Scan {
  violations: PolicyViolation[];
  added: number;
  removed: number;
}

/**
 * ASCII character references and escapes: JS unicode and hex escapes (backslash then u, u{...} or
 * x) and HTML numeric references (`&#104;`, `&#x68;`), plus the named references that spell URL
 * punctuation. A browser or the JS engine reads these as the character, so an escaped javascript:
 * scheme or an escaped fetch( means what the plain spelling means. Only ASCII is decoded: an escaped
 * invisible character is visible in the source.
 */
const ESCAPED_ASCII =
  /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|&#x([0-9a-fA-F]{1,6});?|&#(\d{1,7});?|&(Tab|NewLine|colon|lpar|rpar|sol|period);/g;
const NAMED_REFERENCES: Record<string, string> = {
  Tab: '\t',
  NewLine: '\n',
  colon: ':',
  lpar: '(',
  rpar: ')',
  sol: '/',
  period: '.',
};
/** Tab, LF, CR and printable ASCII */
const isPlainAscii = (code: number): boolean =>
  code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x7e);

/**
 * The line as its escapes spell it, with the tabs and newlines a URL parser drops removed too
 * (`jav&Tab;ascript:`). Matching rules against both spellings keeps an escape from hiding a keyword.
 */
function decodeAscii(segment: string): string {
  const decoded = segment.replace(
    ESCAPED_ASCII,
    (
      whole: string,
      braced?: string,
      unicode4?: string,
      hex2?: string,
      entityHex?: string,
      entityDec?: string,
      named?: string,
    ) => {
      if (named !== undefined) return NAMED_REFERENCES[named] ?? whole;
      const code =
        entityDec !== undefined
          ? Number.parseInt(entityDec, 10)
          : Number.parseInt(braced ?? unicode4 ?? hex2 ?? entityHex ?? '', 16);
      return isPlainAscii(code) ? String.fromCharCode(code) : whole;
    },
  );
  return decoded.replace(/[\t\n\r]/g, '');
}

/**
 * A diff splits lines at LF only, but JavaScript also ends a line at a lone CR, U+2028 and U+2029.
 * Rules are tested one such physical line at a time, so `^`-anchored rules cannot be dodged by a
 * line break the diff format does not see.
 */
const SOURCE_LINE_BREAK = /\r\n?|[\u{2028}\u{2029}]/u;

function scanDiff(diff: string): Scan {
  const violations: PolicyViolation[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of parseDiff(diff)) {
    const path = cutTo(displaySafe(hunk.path), PATH_MAX_CHARS);
    for (const entry of hunk.lines) {
      if (entry.kind === 'context') continue;
      if (entry.kind === 'added') added += 1;
      else removed += 1;
      const physical = entry.text.split(SOURCE_LINE_BREAK).map((segment) => ({
        segment,
        decoded: /[\\&]/.test(segment) ? decodeAscii(segment) : segment,
      }));
      for (const rule of CONTENT_RULES) {
        if (rule.direction !== entry.kind) continue;
        const hit = physical.find(
          ({ segment, decoded }) =>
            rule.pattern.test(segment) || (decoded !== segment && rule.pattern.test(decoded)),
        )?.segment;
        if (hit === undefined) continue;
        const { context } = rule;
        if (context && !(context.test(hunk.path) || hunk.lines.some((o) => context.test(o.text)))) {
          continue;
        }
        violations.push({
          rule: rule.rule,
          path,
          direction: rule.direction,
          line: excerptOf(hit),
          why: rule.why,
        });
      }
    }
  }
  return { violations, added, removed };
}

/**
 * Every rule that fires on an added line (or, for the removal rules, a removed line) of the diff, in
 * diff order. Headers and context lines never match.
 */
export function findPolicyViolations(diff: string): PolicyViolation[] {
  return scanDiff(diff).violations;
}

/**
 * Model-written text made inert for a Markdown table or a PR body, which render a check's detail:
 * & < > become entities (no HTML, no autolink brackets) and `](` is broken (no [text](url) links or
 * images). The reader sees the characters; nothing is interpreted.
 */
function inert(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\]\(/g, ']&#40;');
}

/** The violation lines joined, cut to 2000 characters with '... and N more' when they do not fit. */
function formatDetail(violations: PolicyViolation[]): string {
  const lines = violations.map((v) => `${v.rule} (${inert(v.path)}): ${inert(v.line)}`);
  const all = lines.join('\n');
  if (all.length <= DETAIL_MAX_CHARS) return all;

  const kept: string[] = [];
  for (const line of lines) {
    const rest = lines.length - kept.length - 1;
    const candidate = `${[...kept, line].join('\n')}\n... and ${rest} more`;
    if (candidate.length > DETAIL_MAX_CHARS) break;
    kept.push(line);
  }
  const more = `... and ${lines.length - kept.length} more`;
  return kept.length > 0 ? `${kept.join('\n')}\n${more}` : more;
}

/**
 * id `content_policy`. Passed when no rule fires; otherwise failed, and the detail lists
 * `rule (path): excerpt` lines (at most 2000 characters, then '... and N more'). The excerpts are the
 * model's text, so the detail carries them with & < > as entities and no `](`: safe in the Markdown
 * record and the pull request body as it stands.
 */
export function checkContentPolicy(diff: string): CodeFixCheck {
  const { violations, added, removed } = scanDiff(diff);
  if (violations.length === 0) {
    return {
      id: 'content_policy',
      status: 'passed',
      detail: `no violations in ${added} added and ${removed} removed lines (${CONTENT_RULES.length} rules)`,
    };
  }
  return { id: 'content_policy', status: 'failed', detail: formatDetail(violations) };
}
