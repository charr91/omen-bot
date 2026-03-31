export function canonicalizeEvmAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function canonicalizeOptionalEvmAddress(address: string | null): string | null {
  return address === null ? null : canonicalizeEvmAddress(address);
}
