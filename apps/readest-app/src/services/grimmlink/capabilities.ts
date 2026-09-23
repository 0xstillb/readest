/** Server capabilities are optional additions; unknown servers keep optional features disabled. */
export const hasGrimmLinkCapability = (
  capabilities: readonly string[] | undefined,
  capability: string,
): boolean => !!capabilities?.some((item) => item.toLowerCase() === capability.toLowerCase());
