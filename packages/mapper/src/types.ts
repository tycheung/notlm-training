/**
 * Playwright / HTML DOM inventory types.
 */

export type InventoriedControl = {
  role: string;
  name: string;
  selectorHint: string;
  existingGuideId: string | null;
  proposedGuideId: string;
  url: string;
  landmark?: string;
};

export type ControlInventory = {
  capturedAt: string;
  baseUrl: string;
  controls: InventoriedControl[];
};

export type CrawlHtmlOptions = {
  /** Page URL associated with this HTML snapshot. */
  url?: string;
  /** Origin used for relative links / inventory.baseUrl. */
  baseUrl?: string;
};
