import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Small helpers shared by every view. */

export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const money = (n: number) => `$${n.toFixed(2)}`;

const IMAGES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'images',
);
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Public URL of public/images/<name>.{jpg,jpeg,png,webp}, or undefined if no file is there.
 * Checked on each render so dropping an image in shows up without a restart.
 */
export function imageUrl(name: string): string | undefined {
  for (const ext of IMAGE_EXTS) {
    if (fs.existsSync(path.join(IMAGES_DIR, name + ext))) return `/static/images/${name}${ext}`;
  }
  return undefined;
}

/**
 * Product photo, or a placeholder tile until a photo is added.
 * Pass alt '' when the image is decorative (e.g. a card whose link text already names the product).
 */
export function productImage(
  name: string,
  alt: string,
  opts: { className?: string; placeholder?: string } = {},
): string {
  const url = imageUrl(name);
  const cls = opts.className ? ` ${opts.className}` : '';
  if (url) return `<img class="thumb${cls}" src="${url}" alt="${esc(alt)}">`;
  const a11y = alt ? `role="img" aria-label="${esc(alt)}"` : 'aria-hidden="true"';
  return `<div class="thumb placeholder${cls}" ${a11y}><span aria-hidden="true">${esc(opts.placeholder ?? alt)}</span></div>`;
}
