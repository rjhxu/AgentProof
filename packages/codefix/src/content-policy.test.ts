import { describe, expect, it } from 'vitest';
import {
  CONTENT_RULES,
  checkContentPolicy,
  findPolicyViolations,
  type PolicyViolation,
} from './content-policy';
import { SECRET_PATTERNS } from './untrusted';

const fileHeader = (path: string): string => `--- a/${path}\n+++ b/${path}\n`;

/** One hunk whose header counts match its body */
function hunkOf(lines: string[], start = 1): string {
  const oldCount = lines.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const newCount = lines.filter((l) => l[0] === ' ' || l[0] === '+').length;
  return `@@ -${start},${oldCount} +${start},${newCount} @@\n${lines.join('\n')}\n`;
}

/** A unified diff of one hunk, for `src/x.ts` unless told otherwise */
function diffOf(lines: string[], path = 'src/x.ts'): string {
  return fileHeader(path) + hunkOf(lines);
}

/** The minimal diff from the brief: one old line replaced by `payload` */
const adding = (payload: string): string => diffOf(['-old', `+${payload}`]);
/** One removed line replaced by something harmless */
const removing = (line: string): string => diffOf([`-${line}`, '+new']);
const rulesOf = (violations: PolicyViolation[]): string[] => violations.map((v) => v.rule);

// Credential-shaped strings are assembled at run time so no literal in this file is one.
const FAKE_SECRETS: Record<string, string> = {
  'anthropic-key': 'sk-ant-' + 'a1B2c3D4e5'.repeat(3),
  'openai-style-key': 'sk-' + 'a1B2c3D4e5F6g7H8'.repeat(2),
  'github-token': 'ghp_' + 'a1B2c3D4e5'.repeat(4),
  'xai-key': 'xai-' + 'a1B2c3D4e5'.repeat(5),
  'aws-key': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'slack-token': 'xoxb-' + '1234567890-abcdef',
  'private-key': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'google-key': 'AIza' + 'a1B2c3D4e5'.repeat(3) + 'a1B2c',
  'generic-bearer': 'Authorization: ' + 'a1B2c3D4e5'.repeat(4),
  'openai-project-key': 'sk-proj-' + 'a1B2c3D4e5'.repeat(4),
  'stripe-key': 'sk_live_' + 'a1B2c3D4e5F6g7H8',
};

const ADDED_PAYLOADS: Array<[rule: string, payload: string]> = [
  ['external-url', '<img src="https://evil.example/pixel.png">'],
  ['network-api', "fetch('/api/cart', { method: 'POST' });"],
  ['dynamic-code', 'const run = new Function(code);'],
  ['process-and-fs', 'const key = process.env.ANTHROPIC_API_KEY;'],
  ['script-injection', '<script src="/assets/x.js"></script>'],
  ['obfuscation', "const s = atob('aGVsbG8=');"],
  ['invisible-chars', 'const label = "Size\u{200B}";'],
  ['new-package-import', "import leftPad from 'left-pad';"],
  ['human-visibility', '.size-picker { display: none; }'],
  ...Object.entries(FAKE_SECRETS).map(([name, secret]): [string, string] => [
    `secret-like:${name}`,
    `const token = '${secret}';`,
  ]),
];

describe('CONTENT_RULES', () => {
  it('names the documented rules, in order', () => {
    const names = CONTENT_RULES.map((r) => r.rule);
    const withoutSecrets = names.filter((n) => !n.startsWith('secret-like:'));
    expect(withoutSecrets).toEqual([
      'external-url',
      'network-api',
      'dynamic-code',
      'process-and-fs',
      'script-injection',
      'obfuscation',
      'invisible-chars',
      'new-package-import',
      'human-visibility',
      'payment-guard-removed',
      '403-removed',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has one secret-like rule per credential pattern', () => {
    for (const { name } of SECRET_PATTERNS) {
      expect(CONTENT_RULES.map((r) => r.rule)).toContain(`secret-like:${name}`);
    }
  });

  it('explains every rule and never uses a global or sticky pattern', () => {
    for (const rule of CONTENT_RULES) {
      expect(rule.why.length).toBeGreaterThan(10);
      expect(rule.pattern.global).toBe(false);
      expect(rule.pattern.sticky).toBe(false);
    }
  });

  it('applies exactly two rules to removed lines', () => {
    expect(CONTENT_RULES.filter((r) => r.direction === 'removed').map((r) => r.rule)).toEqual([
      'payment-guard-removed',
      '403-removed',
    ]);
  });
});

describe('findPolicyViolations: added lines', () => {
  it.each(ADDED_PAYLOADS)('%s fires on an added line', (rule, payload) => {
    const violations = findPolicyViolations(adding(payload));
    expect(rulesOf(violations)).toEqual([rule]);
    expect(violations[0]).toMatchObject({ rule, path: 'src/x.ts', direction: 'added' });
    expect(violations[0]?.why.length).toBeGreaterThan(10);
    expect(violations[0]?.line.length).toBeLessThanOrEqual(160);
  });

  it.each(ADDED_PAYLOADS)(
    '%s does not fire on the same text as a removed line',
    (_rule, payload) => {
      expect(findPolicyViolations(removing(payload))).toEqual([]);
    },
  );

  it('cuts the excerpt to 160 characters and trims it', () => {
    const long = findPolicyViolations(adding(`  fetch('/api/${'a'.repeat(400)}');`)).find(
      (v) => v.rule === 'network-api',
    );
    expect(long?.line).toHaveLength(160);
    expect(long?.line.startsWith("fetch('/api/aaaa")).toBe(true);
    expect(long?.line.endsWith('…')).toBe(true);

    const [short] = findPolicyViolations(adding("   fetch('/x');   "));
    expect(short?.line).toBe("fetch('/x');");
  });

  it('reports one violation per rule per line, in diff order', () => {
    const diff = diffOf([
      ' keep',
      "+fetch('https://evil.example/a');",
      '+const ok = 1;',
      '+eval(code);',
    ]);
    expect(findPolicyViolations(diff).map((v) => [v.rule, v.line])).toEqual([
      ['external-url', "fetch('https://evil.example/a');"],
      ['network-api', "fetch('https://evil.example/a');"],
      ['dynamic-code', 'eval(code);'],
    ]);
  });

  describe('external-url', () => {
    it.each([
      'const u = "https://evil.example/x.js";',
      'const u = "HTTP://EVIL.EXAMPLE";',
      'const u = "http://localhost.evil.example/x";',
      'const u = "http://localhost@evil.example/x";',
      'const u = "http://127.0.0.1.nip.io/x";',
      'const u = "http://0.0.0.0.evil.example/x";',
      'const u = "wss://evil.example/socket";',
      'const u = "ftp://evil.example/x";',
      '<link rel="stylesheet" href="//evil.example/x.css">',
      '<img src=//evil.example/x.png>',
      '<form action="//evil.example/collect">',
      '.a { background: url(//evil.example/x.png); }',
      '@import "//evil.example/x.css";',
    ])('flags %s', (payload) => {
      expect(rulesOf(findPolicyViolations(adding(payload)))).toContain('external-url');
    });

    it.each([
      'const u = "http://localhost:3000/cart";',
      'const u = "http://localhost/cart";',
      'const u = "http://localhost";',
      'const u = `http://localhost:${port}/health`;',
      'const u = "http://127.0.0.1:5050/health";',
      'const u = "http://0.0.0.0:80/";',
      'const u = "http://[::1]:5000/";',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>',
      '<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#plus"/>',
      '<a href="/cart">Cart</a>',
      '<form method="post" action="/api/cart">',
      '<img src="/images/hoodie.png" alt="">',
    ])('allows %s', (payload) => {
      expect(rulesOf(findPolicyViolations(adding(payload)))).not.toContain('external-url');
    });
  });

  describe('other families', () => {
    it.each([
      ['network-api', 'const socket = new WebSocket(url);'],
      ['network-api', 'navigator.sendBeacon(path, data);'],
      ['network-api', 'const x = new XMLHttpRequest();'],
      ['network-api', "import https from 'node:https';"],
      ['network-api', 'https.get(options, cb);'],
      ['network-api', 'new Image().src = pixelPath;'],
      ['dynamic-code', 'eval(source);'],
      ['dynamic-code', 'setTimeout("go()", 10);'],
      ['dynamic-code', "const mod = await import('./x');"],
      ['dynamic-code', 'vm.runInNewContext(code);'],
      ['process-and-fs', "import { execSync } from 'node:child_process';"],
      ['process-and-fs', "import { readFile } from 'fs/promises';"],
      ['process-and-fs', "fs.writeFileSync('x', data);"],
      ['process-and-fs', 'process.exit(1);'],
      ['process-and-fs', "import os from 'node:os';"],
      ['script-injection', '<script>go()</script>'],
      ['script-injection', '<a href="javascript:go()">x</a>'],
      ['script-injection', 'const c = document.cookie;'],
      ['script-injection', 'node.innerHTML = html;'],
      ['script-injection', "node.insertAdjacentHTML('beforeend', html);"],
      ['script-injection', '<iframe srcdoc="x"></iframe>'],
      ['obfuscation', 'const s = "\\x68\\x65\\x6c\\x6c\\x6f";'],
      ['obfuscation', 'const s = "\\u0068\\u0065\\u006c\\u006c";'],
      ['obfuscation', "const s = Buffer.from(blob, 'base64');"],
      ['obfuscation', 'const s = String.fromCharCode(104, 105);'],
      ['obfuscation', `const blob = "${'QUJD'.repeat(40)}";`],
      ['invisible-chars', 'const a = "x\u{202E}y";'],
      ['invisible-chars', 'const a = "x\u{E0041}y";'],
      ['invisible-chars', '\u{FEFF}const a = 1;'],
      ['new-package-import', "const lodash = require('lodash');"],
      ['new-package-import', "import 'side-effect';"],
      ['new-package-import', "import { a, b } from '@scope/pkg';"],
      ['new-package-import', "export * from 'pkg';"],
      ['new-package-import', "} from 'pkg';"],
      ['human-visibility', 'el.style.display = "none";'],
      ['human-visibility', '.chip { visibility: hidden; }'],
      ['human-visibility', '.chip { opacity: 0; }'],
      ['human-visibility', '.chip { pointer-events: none; }'],
    ])('%s fires on %s', (rule, payload) => {
      expect(rulesOf(findPolicyViolations(adding(payload)))).toContain(rule);
    });

    it('does not flag harmless lines from the same families', () => {
      const harmless = [
        'const price = money(product.basePrice);',
        'const sizes = attributeValues(product, "size");',
        '.chip { opacity: 0.5; }',
        '.chip { display: inline-flex; }',
        '<input type="hidden" name="size" value="M">',
        '.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }',
        "import type { Product } from './catalog';",
        "import { optionGroup } from '../controls';",
        "import path from 'node:path';",
        'const re = /ab+c/; const m = re.exec(text);',
        'const fetched = cache.get(key);',
        '// refetch when the variant changes',
        'const evaluation = evaluate(product);',
      ];
      expect(findPolicyViolations(diffOf(['-old', ...harmless.map((l) => `+${l}`)]))).toEqual([]);
    });
  });

  it('allows node: built-ins that are neither network nor process nor filesystem', () => {
    expect(findPolicyViolations(adding("import path from 'node:path';"))).toEqual([]);
    expect(findPolicyViolations(adding("import { x } from './controls';"))).toEqual([]);
  });

  it('flags node:fs under process-and-fs and not under new-package-import', () => {
    const violations = findPolicyViolations(adding("import fs from 'node:fs';"));
    expect(rulesOf(violations)).toEqual(['process-and-fs']);
  });
});

describe('findPolicyViolations: removed lines', () => {
  it('flags a removed payment guard', () => {
    const guard = "app.post('/checkout/place-order', async (_req, reply) => {";
    const violations = findPolicyViolations(removing(guard));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: 'payment-guard-removed',
      path: 'src/x.ts',
      direction: 'removed',
      line: guard,
    });
  });

  it.each([
    '<button type="submit" id="place-order">Place order</button>',
    'if (!paymentAuthorized(req)) return deny();',
    'const blocked = isPaymentControl(label);',
    'function placeOrder(cart) {',
  ])('flags the removal of %s', (line) => {
    expect(rulesOf(findPolicyViolations(removing(line)))).toEqual(['payment-guard-removed']);
  });

  it('does not apply the removal rules to added or context lines', () => {
    const guard = "app.post('/checkout/place-order', async (_req, reply) => {";
    expect(findPolicyViolations(diffOf(['-old', `+${guard}`]))).toEqual([]);
    expect(findPolicyViolations(diffOf([` ${guard}`, '-old', '+new']))).toEqual([]);
  });

  it('flags a removed 403 only with checkout, order or payment context', () => {
    const unrelated = diffOf([
      '-  reply.code(403).send({ error: "forbidden" });',
      '+  reply.sent;',
    ]);
    expect(findPolicyViolations(unrelated)).toEqual([]);

    const withContext = diffOf([
      '-  reply.code(403).send({ error: "payment required" });',
      '+  ok',
    ]);
    expect(rulesOf(findPolicyViolations(withContext))).toEqual(['403-removed']);
    expect(findPolicyViolations(withContext)[0]?.direction).toBe('removed');
  });

  it('finds the context on a neighbouring line, as in the store place-order handler', () => {
    const diff = diffOf([
      " app.post('/checkout/place-order', async (_req, reply) => {",
      '   reply',
      '-    .code(403)',
      "     .type('text/html')",
      '   ;',
    ]);
    expect(rulesOf(findPolicyViolations(diff))).toEqual(['403-removed']);
  });

  it('takes the file path as context too', () => {
    const diff = diffOf(['-    .code(403)', '+    .code(200)'], 'src/checkout.ts');
    expect(rulesOf(findPolicyViolations(diff))).toEqual(['403-removed']);
    expect(findPolicyViolations(diffOf(['-    .code(403)', '+    .code(200)']))).toEqual([]);
  });

  it('counts the words on added lines of the hunk as context too', () => {
    const diff = diffOf(['-    .code(403)', '+    .code(401)', '+    // order of checks']);
    expect(rulesOf(findPolicyViolations(diff))).toEqual(['403-removed']);
  });
});

describe('findPolicyViolations: reading the diff', () => {
  it('never matches headers or context lines', () => {
    const diff = [
      '--- a/src/x.ts',
      '+++ b/https://evil.example/x.ts',
      '@@ -1,3 +1,3 @@',
      ' fetch("https://evil.example/context")',
      '-old',
      '+new',
      ' eval(context)',
      '',
    ].join('\n');
    expect(findPolicyViolations(diff)).toEqual([]);
  });

  it('does not take git metadata for content', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 1111111..2222222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(findPolicyViolations(diff)).toEqual([]);
  });

  it('reads an added line that starts with ++ as content, not as a header', () => {
    const diff = diffOf([' keep', '+++<script src="https://evil.example/x.js"></script>', ' keep']);
    const violations = findPolicyViolations(diff);
    expect(rulesOf(violations)).toEqual(['external-url', 'script-injection']);
    expect(violations[0]?.line).toBe('++<script src="https://evil.example/x.js"></script>');
  });

  it('reads a removed line that starts with -- as content, not as a header', () => {
    const diff = diffOf([' keep', '----place-order guard', '+new', ' keep']);
    const violations = findPolicyViolations(diff);
    expect(rulesOf(violations)).toEqual(['payment-guard-removed']);
    expect(violations[0]?.direction).toBe('removed');
  });

  it('still reads the lines when the hunk header understates them', () => {
    const diff = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+a\n+eval(x)\n+fetch("/y")\n';
    expect(rulesOf(findPolicyViolations(diff))).toEqual(['dynamic-code', 'network-api']);
  });

  it('reads content lines of a diff with no hunk headers', () => {
    const diff = '+++ b/src/y.ts\n+eval(x)\n-place-order\n';
    expect(findPolicyViolations(diff).map((v) => [v.rule, v.path, v.direction])).toEqual([
      ['dynamic-code', 'src/y.ts', 'added'],
      ['payment-guard-removed', 'src/y.ts', 'removed'],
    ]);
  });

  it('attributes each violation to its own file', () => {
    const diff =
      diffOf(['-a', '+eval(1)'], 'src/a.ts') + diffOf(['-b', '+fetch("/x")'], 'src/b.ts');
    expect(findPolicyViolations(diff).map((v) => [v.rule, v.path])).toEqual([
      ['dynamic-code', 'src/a.ts'],
      ['network-api', 'src/b.ts'],
    ]);
  });

  it('attributes removed lines of a deleted file to the old path', () => {
    const diff =
      '--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-app.post("/checkout/place-order");\n';
    expect(findPolicyViolations(diff).map((v) => [v.rule, v.path])).toEqual([
      ['payment-guard-removed', 'src/gone.ts'],
    ]);
  });

  it('reads a CRLF diff', () => {
    const diff = '--- a/src/x.ts\r\n+++ b/src/x.ts\r\n@@ -1 +1 @@\r\n-old\r\n+eval(x)\r\n';
    expect(findPolicyViolations(diff).map((v) => [v.rule, v.path, v.line])).toEqual([
      ['dynamic-code', 'src/x.ts', 'eval(x)'],
    ]);
  });

  it('reads a lone CR, U+2028 or U+2029 inside a line as a line break', () => {
    const bare = "import evil from 'evil';";
    for (const breaker of ['\r', '\u{2028}', '\u{2029}']) {
      const violations = findPolicyViolations(adding(`const x = 1;${breaker}${bare}`));
      expect(rulesOf(violations)).toEqual(['new-package-import']);
      expect(violations[0]?.line).toBe(bare);
    }
  });

  it('sees through unusual leading whitespace before an import', () => {
    const violations = findPolicyViolations(adding("\u{A0}\u{3000}import evil from 'evil';"));
    expect(rulesOf(violations)).toEqual(['new-package-import']);
  });

  it.each([
    ['script-injection', '<a href="&#106;avascript:go()">x</a>'],
    ['script-injection', '<a href="jav&Tab;ascript&colon;go()">x</a>'],
    ['script-injection', '<a href="j&#x61;vascript:go()">x</a>'],
    ['external-url', '<img src="&#104;ttps://evil.example/x.png">'],
    ['external-url', 'const u = "\\x68ttps://evil.example/x";'],
    ['network-api', "\\u0066etch('/api/cart');"],
    ['network-api', "\\u{66}etch('/api/cart');"],
    ['dynamic-code', '\\u0065val(code);'],
    ['process-and-fs', 'process\\x2eenv.KEY'],
  ])('%s fires through an escaped spelling: %s', (rule, payload) => {
    const violations = findPolicyViolations(adding(payload));
    expect(rulesOf(violations)).toContain(rule);
    // the excerpt shows the line as written, not as decoded
    expect(violations.find((v) => v.rule === rule)?.line).toBe(payload);
  });

  it('does not decode escapes that spell anything but ASCII', () => {
    const lines = [
      "const minus = '\\u2212';",
      "const zwsp = '\\u{200B}';",
      "const bidi = '\\u202E';",
      "const shy = '&#173;';",
      "const apos = 'Men&#39;s';",
      "const e = '\\u00e9';",
    ];
    expect(findPolicyViolations(diffOf(['-old', ...lines.map((l) => `+${l}`)]))).toEqual([]);
  });

  it('returns nothing for an empty diff or one with only context', () => {
    expect(findPolicyViolations('')).toEqual([]);
    expect(findPolicyViolations(diffOf([' fetch("https://evil.example")']))).toEqual([]);
  });

  it('stays fast on long lines and many lines', () => {
    const started = Date.now();
    const lines = Array.from({ length: 300 }, (_, i) => `+${'a '.repeat(i % 2 ? 9000 : 1)}x`);
    findPolicyViolations(diffOf(['-old', ...lines]));
    findPolicyViolations(diffOf(['-old', `+${' '.repeat(150_000)}x`]));
    findPolicyViolations(diffOf(['-old', `+Buffer.from(${'Buffer.from('.repeat(5000)}`]));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('excerpts', () => {
  it('redacts credentials', () => {
    const secret = FAKE_SECRETS['github-token'] ?? '';
    const violations = findPolicyViolations(adding(`const t = "${secret}"; fetch("/x");`));
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      expect(v.line).toContain('[redacted]');
      expect(v.line).not.toContain(secret);
      expect(v.line).not.toContain(secret.slice(0, 12));
    }
  });

  it('names invisible and control characters instead of rendering them', () => {
    const [v] = findPolicyViolations(adding('const a = "x\u{202E}y\u{E0041}z\x07";'));
    expect(v?.rule).toBe('invisible-chars');
    expect(v?.line).toBe('const a = "x[U+202E]y[U+E0041]z[U+0007]";');
  });

  it('turns tabs into spaces and drops a trailing carriage return', () => {
    const [v] = findPolicyViolations(adding('\t\tfetch(\t"/x");\r'));
    expect(v?.line).toBe('fetch( "/x");');
  });
});

describe('checkContentPolicy', () => {
  // The Bug A reference fix: the hoodie page uses the shared optionGroup() and the hand-rolled chip
  // picker, with its mouse-only script, goes away.
  const GOOD_DIFF =
    fileHeader('apps/storefront/src/views.ts') +
    hunkOf([
      " import type { Cart } from './cart';",
      "-import { attributeValues, valueInStock, type Product } from './catalog';",
      "+import type { Product } from './catalog';",
      " import { buyForm, optionGroup, quantityInput, remainingOptions } from './controls';",
      " import { featureLayout } from './feature-layout';",
    ]) +
    hunkOf(
      [
        ' }',
        ' ',
        '-function legacySizeChips(product: Product): string {',
        '-  const chips = sizes.map((s) => `<div class="chip" data-size="${esc(s)}">${esc(s)}</div>`);',
        '-    <script>',
        "-        document.querySelector('input[name=size]').value = chip.dataset.size;",
        '-    </script>`;',
        '-}',
        ' export function productPage(product: Product): string {',
        "-    case 'classic': // hoodies: legacy chip size picker (DEMO BUG A)",
        "+    case 'classic': // hoodies",
        '       page = productShell(',
        '         product,',
        "-        legacySizeChips(product) + remainingOptions(product, ['size']) + quantityInput(),",
        "+        optionGroup(product, 'size') + remainingOptions(product, ['size']) + quantityInput(),",
        '       );',
      ],
      59,
    );

  // The Bug D reference fix: names for the icon-only buttons, a labelled group, an <output>.
  const STEPPER_DIFF = diffOf([
    '-const MINUS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12h14"/></svg>`;',
    '+const MINUS_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M5 12h14"/></svg>`;',
    '-      <div class="stepper" data-stepper data-max="${max}">',
    '+      <span class="option-label" id="qty-label">Quantity</span>',
    '+      <div class="stepper" role="group" aria-labelledby="qty-label" data-stepper data-max="${max}">',
    '+        <button type="button" class="stepper-btn" data-step="-1" aria-label="Decrease quantity">${MINUS_ICON}</button>',
    '+        <output class="stepper-value" aria-live="polite" data-stepper-value>1</output>',
    '+        <input type="hidden" name="quantity" value="1">',
  ]);

  it('passes a realistic good diff with zero violations', () => {
    expect(findPolicyViolations(GOOD_DIFF)).toEqual([]);
    const check = checkContentPolicy(GOOD_DIFF);
    expect(check.id).toBe('content_policy');
    expect(check.status).toBe('passed');
    expect(check.detail).toMatch(/^no violations in 3 added and 9 removed lines/);
  });

  it('passes the stepper fix too', () => {
    expect(findPolicyViolations(STEPPER_DIFF)).toEqual([]);
    expect(checkContentPolicy(STEPPER_DIFF).status).toBe('passed');
  });

  it('passes an empty diff', () => {
    const check = checkContentPolicy('');
    expect(check).toMatchObject({ id: 'content_policy', status: 'passed' });
  });

  it('fails with one line per violation: rule (path): excerpt', () => {
    const diff = diffOf([
      '-old',
      "+fetch('https://evil.example/x');",
      '+const ok = 1;',
      '+eval(c);',
    ]);
    const check = checkContentPolicy(diff);
    expect(check.id).toBe('content_policy');
    expect(check.status).toBe('failed');
    expect(check.detail.split('\n')).toEqual([
      "external-url (src/x.ts): fetch('https://evil.example/x');",
      "network-api (src/x.ts): fetch('https://evil.example/x');",
      'dynamic-code (src/x.ts): eval(c);',
    ]);
  });

  it('bounds the detail to 2000 characters and counts what it left out', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `+eval(${i}); // ${'x'.repeat(100)}`);
    const check = checkContentPolicy(diffOf(['-old', ...lines]));
    expect(check.status).toBe('failed');
    expect(check.detail.length).toBeLessThanOrEqual(2000);
    const shown = check.detail.split('\n').length - 1;
    expect(check.detail).toMatch(new RegExp(`\\n\\.\\.\\. and ${500 - shown} more$`));
    expect(shown).toBeGreaterThan(5);
  });

  it('makes the model text in the detail inert for Markdown', () => {
    const diff = diffOf([
      '-old',
      '+// <img src="https://evil.example/p.png" onerror=go()> & [verify](https://evil.example)',
    ]);
    const { detail } = checkContentPolicy(diff);
    expect(detail).toContain('&lt;img src="https://evil.example/p.png" onerror=go()&gt; &amp; ');
    expect(detail).not.toMatch(/[<>]/);
    expect(detail).not.toContain('](');
    expect(detail).toContain('[verify]&#40;https://evil.example)');
    // the structured violation keeps the model's text as written
    expect(findPolicyViolations(diff)[0]?.line).toContain('<img src=');
  });

  it('makes a link that a redaction would complete inert too', () => {
    const secret = FAKE_SECRETS['github-token'] ?? '';
    const { detail } = checkContentPolicy(adding(`${secret}(https://evil.example)`));
    expect(detail).toContain('[redacted]&#40;https://evil.example)');
  });

  it('keeps a detail that fits exactly as it is', () => {
    const check = checkContentPolicy(diffOf(['-old', '+eval(1);', '+eval(2);']));
    expect(check.detail).toBe(
      'dynamic-code (src/x.ts): eval(1);\ndynamic-code (src/x.ts): eval(2);',
    );
  });

  it('keeps the detail bounded even for an absurd path', () => {
    const path = `src/${'d/'.repeat(3000)}x.ts`;
    const check = checkContentPolicy(diffOf(['-old', ...Array(40).fill('+eval(1);')], path));
    expect(check.detail.length).toBeLessThanOrEqual(2000);
    expect(check.detail).toMatch(/\.\.\. and \d+ more$/);
  });

  it('is deterministic', () => {
    const diff = adding("fetch('https://evil.example');");
    expect(checkContentPolicy(diff)).toEqual(checkContentPolicy(diff));
  });
});
