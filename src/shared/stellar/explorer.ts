// Explorer link builder (design 4.2): `${EXPLORER_BASE_URL}/tx/${txHash}`.
// This is the pure formatting half of S1-R4 evidence; where the hash itself
// comes from is resolved by spike S3 in the code that calls this.

export function buildExplorerUrl(baseUrl: string, txHash: string): string {
  if (txHash.length === 0) {
    throw new RangeError("buildExplorerUrl: txHash must not be empty");
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}/tx/${txHash}`;
}
