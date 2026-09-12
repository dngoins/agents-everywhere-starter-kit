export const vehicleChoices = [
  {
    id: "tesla-model-y",
    name: "Tesla Model Y",
    make: "Tesla",
    model: "Model Y",
    appearance: "The exact Tesla Model Y shown in the supplied exterior and interior photographs. Preserve its body generation, lights, wheels, paint and cabin; do not substitute Model S or another trim.",
  },
  {
    id: "toyota-tundra-hybrid",
    name: "Toyota Tundra Hybrid",
    make: "Toyota",
    model: "Tundra i-FORCE MAX Hybrid",
    appearance: "The exact Toyota Tundra hybrid pickup shown in the supplied exterior and interior photographs. Preserve cab, bed, grille, wheels, paint and cabin; do not substitute a non-hybrid model or another trim.",
  },
] as const;

export type VehicleChoiceId = typeof vehicleChoices[number]["id"];
export function vehicleChoice(id: string) { return vehicleChoices.find(choice => choice.id === id); }
