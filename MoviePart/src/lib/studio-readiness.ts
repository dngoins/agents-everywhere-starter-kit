import type { ConfigView } from "../../integration/contracts";
import { vehicleChoices } from "../catalog/vehicles";

export function selectableProducts(config: ConfigView | null): ConfigView["products"] {
  const configured = new Map(config?.products.map(product => [product.id, product]) ?? []);
  const products = vehicleChoices.map(choice => configured.get(choice.id) ?? {
    id: choice.id, name: choice.name, ready: false,
  });
  return [...products, ...(config?.products.filter(product => !vehicleChoices.some(choice => choice.id === product.id)) ?? [])];
}

export function creationBlockers(input: {
  config: ConfigView | null; productId: string; needsPhotos: boolean;
  photoCount: number; generationConsent: boolean; personalizationConsent: boolean;
}): string[] {
  const blockers: string[] = [];
  if (!input.productId) blockers.push("Choose Tesla Model Y or Toyota Tundra Hybrid.");
  else if (!input.config?.products.some(product => product.id === input.productId && product.ready)) {
    blockers.push("Add permitted exterior and interior reference photos for your selected car, then save the reference pack.");
  }
  if (input.needsPhotos && !input.photoCount) blockers.push("Add a customer photo, or select First-person or Personalized mode.");
  if (!input.generationConsent) blockers.push("Confirm permission for the selected generation mode.");
  if (!input.personalizationConsent) blockers.push("Confirm permission to use the interests you provide.");
  if (!input.config) blockers.push("Reconnect to the studio server to load its configuration.");
  else {
    if (!input.config.providers.openai.available) blockers.push(input.config.providers.openai.message);
    if (!input.config.worker.available) blockers.push(input.config.worker.message);
    if (!input.config.renderer.available) blockers.push(input.config.renderer.message);
  }
  return blockers;
}
