/** Stable slug for proposed `data-guide-id` values: `guide-{role}-{slug}`. */
export function proposeGuideId(role: string, name: string): string {
  const roleSlug = slugify(role) || 'control';
  const nameSlug = slugify(name) || 'unnamed';
  return `guide-${roleSlug}-${nameSlug}`;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}
