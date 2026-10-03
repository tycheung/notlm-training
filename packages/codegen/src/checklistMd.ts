/**
 * Markdown export of checklist.json for PRs.
 * Docs / review aid only — never emits application TypeScript.
 */

export type ChecklistItem = {
  id?: string;
  kind?: string;
  message?: string;
  text?: string;
  severity?: string;
  checked?: boolean;
  proposedGuideId?: string;
};

export type ChecklistJson = {
  items?: ChecklistItem[];
};

function itemBody(item: ChecklistItem): string {
  return item.message ?? item.text ?? item.id ?? '(untitled)';
}

function itemMeta(item: ChecklistItem): string {
  return [item.kind, item.severity].filter(Boolean).join(' · ');
}

export function checklistToMarkdown(checklist: ChecklistJson | ChecklistItem[]): string {
  const items = Array.isArray(checklist) ? checklist : (checklist.items ?? []);
  const lines: string[] = ['# NotLM checklist', ''];

  if (items.length === 0) {
    lines.push('_No items._', '');
    return lines.join('\n');
  }

  for (const item of items) {
    const box = item.checked === true ? '[x]' : '[ ]';
    const meta = itemMeta(item);
    const prefix = meta ? `**${meta}**: ` : '';
    const guide =
      typeof item.proposedGuideId === 'string' && item.proposedGuideId
        ? ` (\`${item.proposedGuideId}\`)`
        : '';
    lines.push(`- ${box} ${prefix}${itemBody(item)}${guide}`);
  }

  lines.push('');
  return lines.join('\n');
}
