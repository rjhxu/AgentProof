import { describe, expect, it } from 'vitest';
import type { AgentKind, RunStep } from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import type { LlmContentBlock } from './llm-types';
import {
  HISTORY_STEPS,
  SNAPSHOT_CHAR_CAP,
  TEXT_CHAR_CAP,
  buildNarrativePrompt,
  buildUserTurn,
  systemPromptFor,
  type ObservationInput,
} from './prompts';

const ALPHA: AgentKind = 'alpha_semantic';
const BETA: AgentKind = 'beta_vision';
const SIGMA: AgentKind = 'sigma_hybrid';

const TREE = `- heading "Black Hoodie" [level=1]
- paragraph: $49.00
- text: Size S M L Color Black Quantity
- spinbutton "Quantity": "1"
- button "Add to cart"`;
const TEXT = 'Black Hoodie $49.00 Size S M L Color Black Quantity 1 Add to cart';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const observation: ObservationInput = {
  url: 'http://localhost:5000/products/black-hoodie',
  title: 'Black Hoodie - Northwind',
  ariaSnapshot: TREE,
  textExcerpt: TEXT,
  screenshotBase64: PNG_BASE64,
  viewport: { width: 1280, height: 800 },
};

const texts = (blocks: LlmContentBlock[]): string[] =>
  blocks.flatMap((b) => (b.type === 'text' ? [b.text] : []));
const joined = (blocks: LlmContentBlock[]): string => texts(blocks).join('\n');
const images = (blocks: LlmContentBlock[]) => blocks.filter((b) => b.type === 'image');

function turn(kind: AgentKind, over: Partial<Parameters<typeof buildUserTurn>[0]> = {}) {
  return buildUserTurn({
    kind,
    mission: hoodieMission,
    observation,
    history: alphaFailedRun.steps,
    stepsRemaining: 22,
    ...over,
  });
}

describe('systemPromptFor', () => {
  it('is fixed per kind and contains no page content', () => {
    for (const kind of [ALPHA, BETA, SIGMA]) {
      const p = systemPromptFor(kind);
      expect(p).toBe(systemPromptFor(kind));
      expect(p).not.toContain('Northwind');
      expect(p).not.toContain('localhost');
      expect(p).toContain('exactly ONE action');
      expect(p).toContain('JSON');
      expect(p).toContain('untrusted');
    }
  });

  it('forbids placing an order or paying', () => {
    for (const kind of [ALPHA, BETA, SIGMA]) {
      const p = systemPromptFor(kind);
      expect(p).toContain('NEVER click anything that places an order');
      expect(p).toContain('Place order');
      expect(p).toContain('Pay now');
      expect(p).toContain('Buy now');
    }
  });

  it('teaches Alpha the role:name vocabulary and nothing else', () => {
    const p = systemPromptFor(ALPHA);
    for (const example of [
      'link:Black Hoodie',
      'button:Add to cart',
      'radio:M',
      'combobox:Size',
      'spinbutton:Quantity',
      'button:Increase quantity',
      'link:Proceed to checkout',
    ]) {
      expect(p).toContain(example);
    }
    expect(p).not.toContain('412,388');
    expect(p).toContain('tries a radio named M, then a combobox named Size, then a button named M');
  });

  it('teaches Beta pixel coordinates and no roles', () => {
    const p = systemPromptFor(BETA);
    expect(p).toContain('412,388');
    expect(p).toContain('x,y');
    expect(p).not.toContain('button:Add to cart');
    expect(p).toContain('size in pixels is given each turn');
  });

  it('tells Sigma to prefer role:name and fall back to x,y', () => {
    const p = systemPromptFor(SIGMA);
    expect(p).toContain('button:Add to cart');
    expect(p).toContain('412,388');
    expect(p).toMatch(/role:name, preferred/);
    expect(p).toContain('visible in the screenshot but absent from the tree');
  });

  it('explains done and fail', () => {
    const p = systemPromptFor(ALPHA);
    expect(p).toContain('Say done only when');
    expect(p).toContain('3 times');
    expect(p).toContain('say fail');
  });
});

describe('buildUserTurn: Alpha', () => {
  const blocks = turn(ALPHA);
  const all = joined(blocks);

  it('contains no image even when a screenshot is available', () => {
    expect(images(blocks)).toHaveLength(0);
    expect(all).not.toContain(PNG_BASE64);
  });

  it('starts with the mission header, then the tree, text and footer', () => {
    expect(blocks[0]?.type).toBe('text');
    const header = texts(blocks)[0]!;
    expect(header.startsWith('MISSION')).toBe(true);
    expect(header).toContain('"product": "black hoodie"');
    expect(header).toContain('"size": "M"');
    expect(header).toContain('"successMilestone": "checkout_review"');
    expect(header).toContain('"allowedActions"');
    expect(header).toContain('STEPS REMAINING: 22');
    expect(header).toContain('TARGET GRAMMAR: role:name');
    expect(all).toContain('ACCESSIBILITY TREE (what you can perceive):');
    expect(all).toContain('- text: Size S M L Color Black Quantity');
    expect(all).toContain('PAGE TEXT (excerpt):');
    const footer = texts(blocks).at(-1)!;
    expect(footer).toContain('CURRENT URL: http://localhost:5000/products/black-hoodie');
    expect(footer).toContain('PAGE TITLE: Black Hoodie - Northwind');
    expect(footer).toContain('Return exactly one action as JSON.');
  });

  it('never includes the raw prompt', () => {
    expect(all).not.toContain(hoodieMission.rawPrompt);
    expect(all).not.toContain('rawPrompt');
    expect(all).not.toContain('Do not place the order');
  });

  it('summarizes recent steps with outcomes', () => {
    expect(all).toContain('RECENT STEPS');
    expect(all).toContain('#0 click link:Black Hoodie -> ok');
    expect(all).toContain('#1 select combobox:Size = M -> error: No element with role=combobox');
  });

  it('says "none yet" without history', () => {
    expect(joined(turn(ALPHA, { history: [] }))).toContain('RECENT STEPS\nnone yet');
  });

  it('keeps only the last HISTORY_STEPS steps', () => {
    const history: RunStep[] = Array.from({ length: 8 }, (_, i) => ({
      index: i,
      at: 't',
      action: { type: 'scroll', direction: 'down', reason: '' },
      outcome: 'ok',
    }));
    const all8 = joined(turn(ALPHA, { history }));
    expect(HISTORY_STEPS).toBe(5);
    for (let i = 0; i < 3; i++) expect(all8).not.toMatch(new RegExp(`^#${i} `, 'm'));
    for (let i = 3; i < 8; i++) expect(all8).toMatch(new RegExp(`^#${i} scroll down -> ok$`, 'm'));
  });

  it('truncates the tree and text with a marker', () => {
    const bigTree = 'x'.repeat(SNAPSHOT_CHAR_CAP + 1000);
    const bigText = 'y'.repeat(TEXT_CHAR_CAP + 50);
    const all = joined(
      turn(ALPHA, { observation: { ...observation, ariaSnapshot: bigTree, textExcerpt: bigText } }),
    );
    expect(all).toContain('...[truncated 1000 chars]');
    expect(all).toContain('...[truncated 50 chars]');
    expect(all).not.toContain('x'.repeat(SNAPSHOT_CHAR_CAP + 1));
    expect(all).not.toContain('y'.repeat(TEXT_CHAR_CAP + 1));
  });

  it('omits observation blocks that are absent', () => {
    const blocks = turn(ALPHA, {
      observation: { url: 'http://localhost:5000/', title: 'Northwind' },
    });
    expect(blocks).toHaveLength(2);
    expect(joined(blocks)).not.toContain('ACCESSIBILITY TREE');
  });
});

describe('buildUserTurn: Beta', () => {
  const blocks = turn(BETA);
  const all = joined(blocks);

  it('sends the screenshot right after the header, with its size', () => {
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toEqual({ type: 'image', mediaType: 'image/png', base64: PNG_BASE64 });
    expect(blocks[2]).toEqual({
      type: 'text',
      text: 'SCREENSHOT above: 1280x800 pixels; coordinates are x,y in this image',
    });
    expect(images(blocks)).toHaveLength(1);
  });

  it('never receives the accessibility tree or page text (pure vision)', () => {
    expect(all).not.toContain('ACCESSIBILITY TREE');
    expect(all).not.toContain('PAGE TEXT');
    expect(all).not.toContain('Size S M L');
    expect(all).not.toContain(TEXT);
  });

  it('never copies base64 into a text block', () => {
    expect(all).not.toContain(PNG_BASE64);
  });

  it('describes the grammar as x,y and ends with the footer', () => {
    expect(texts(blocks)[0]).toContain('TARGET GRAMMAR: x,y');
    expect(texts(blocks).at(-1)).toContain('Return exactly one action as JSON.');
  });

  it('says so when the viewport size is unknown', () => {
    const b = turn(BETA, { observation: { ...observation, viewport: undefined } });
    expect(texts(b)).toContain(
      'SCREENSHOT above: size not provided; coordinates are x,y in this image',
    );
  });

  it('omits the image when no screenshot was captured', () => {
    const b = turn(BETA, { observation: { ...observation, screenshotBase64: undefined } });
    expect(images(b)).toHaveLength(0);
  });
});

describe('buildUserTurn: Sigma', () => {
  const blocks = turn(SIGMA);
  const all = joined(blocks);

  it('receives image, tree and text, in that order', () => {
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text', 'text', 'text', 'text']);
    expect(images(blocks)).toHaveLength(1);
    const order = texts(blocks);
    expect(order[1]).toContain('SCREENSHOT above: 1280x800 pixels');
    expect(order[2]).toContain('ACCESSIBILITY TREE');
    expect(order[3]).toContain('PAGE TEXT');
    expect(all).toContain(
      'TARGET GRAMMAR: role:name when the control is in the accessibility tree',
    );
  });
});

describe('buildNarrativePrompt', () => {
  const checkpoints = alphaFailedRun.verification!.checkpoints.map((c) => ({
    id: c.id,
    status: c.status,
    detail: c.detail,
  }));
  const { system, user } = buildNarrativePrompt({
    kind: ALPHA,
    mission: hoodieMission,
    steps: alphaFailedRun.steps,
    claim: { outcome: 'done', summary: 'Reached checkout with the default size' },
    checkpoints,
    perceives: ['accessibility tree (role + name)', 'page text excerpt'],
  });

  it('asks for a factual first-person account with step numbers', () => {
    expect(system).toContain('first-person');
    expect(system).toContain('120-200 words');
    expect(system).toContain('step numbers');
    expect(system).toContain('Do not invent');
    expect(system).toContain('Do not claim success');
    expect(system).not.toContain('Black Hoodie');
  });

  it('includes the senses, requirements, step log, claim and checkpoint table', () => {
    expect(user).toContain('Agent Alpha (alpha_semantic)');
    expect(user).toContain('- accessibility tree (role + name)');
    expect(user).toContain('"product": "black hoodie"');
    expect(user).toContain('STEP LOG (3 steps)');
    expect(user).toContain('#0 click link:Black Hoodie -> ok  [at /]');
    expect(user).toContain('#1 select combobox:Size = M -> error');
    expect(user).toContain('[at /products/black-hoodie]');
    expect(user).toContain('AGENT CLAIM AT THE END: done: Reached checkout with the default size');
    expect(user).toContain(
      '- correct_size_identified: failed (Agent could not locate a size control',
    );
    expect(user).toContain('- product_discovered: passed');
    expect(user).toContain('- checkout_review_reached: passed');
  });

  it('never includes the raw prompt and copes with an empty run', () => {
    expect(user).not.toContain(hoodieMission.rawPrompt);
    const empty = buildNarrativePrompt({
      kind: BETA,
      mission: hoodieMission,
      steps: [],
      checkpoints: [],
      perceives: [],
    });
    expect(empty.user).toContain('(no steps were recorded)');
    expect(empty.user).toContain('(no checkpoints were evaluated)');
    expect(empty.user).toContain('none recorded');
  });
});
