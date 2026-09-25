/**
 * Draft glossary stubs from pack controls (guide ids / labels).
 */
export type GlossaryStub = {
  id: string;
  aliases: string[];
  text: string;
  guideId?: string;
};

type ControlLike = {
  id?: string;
  guideId?: string;
  label?: string;
  title?: string;
  stepId?: string;
};

export function glossaryStubsFromControls(controls: ControlLike[]): GlossaryStub[] {
  const out: GlossaryStub[] = [];
  const seen = new Set<string>();
  for (const c of controls) {
    const guideId = c.guideId || c.id;
    if (!guideId || seen.has(guideId)) continue;
    seen.add(guideId);
    const label = (c.label || c.title || guideId).trim();
    if (!label) continue;
    const id = guideId.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();
    out.push({
      id,
      aliases: [label.toLowerCase(), guideId.toLowerCase()],
      text: `“${label}” is a desk control${c.stepId ? ` used in step “${c.stepId}”` : ''}. Ask “what is ${label}?” for help while the form is open.`,
      guideId,
    });
  }
  return out;
}
