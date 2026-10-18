// The app runs a single factory (Water). The hooks are kept so pages that
// scope their queries by factory code don't need to change.
export type FactoryCode = "water";

export function useActiveFactoryCode(): FactoryCode {
  return "water";
}

export function useHydratedFactoryCode(): FactoryCode | null {
  return "water";
}
