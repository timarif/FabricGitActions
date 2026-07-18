export interface FabricEndpoints {
  fabricApiEndpoint: string;
  oneLakeEndpoint: string;
  oneLakeBlobEndpoint: string;
}

export function parseFabricEndpoints(
  fabricApiEndpoint: string,
  oneLakeEndpoint: string,
  oneLakeBlobEndpoint?: string,
): FabricEndpoints {
  const normalizedOneLakeEndpoint = normalizeEndpoint(
    oneLakeEndpoint,
    "onelake-endpoint",
  );
  return {
    fabricApiEndpoint: normalizeEndpoint(
      fabricApiEndpoint,
      "fabric-api-endpoint",
    ),
    oneLakeEndpoint: normalizedOneLakeEndpoint,
    oneLakeBlobEndpoint: normalizeEndpoint(
      oneLakeBlobEndpoint ??
        deriveOneLakeBlobEndpoint(normalizedOneLakeEndpoint),
      "onelake-blob-endpoint",
    ),
  };
}

function deriveOneLakeBlobEndpoint(dfsEndpoint: string): string {
  const url = new URL(dfsEndpoint);
  if (!url.hostname.includes(".dfs.")) {
    throw new Error(
      "onelake-blob-endpoint is required when onelake-endpoint does not use a .dfs. hostname.",
    );
  }
  url.hostname = url.hostname.replace(".dfs.", ".blob.");
  return url.toString().replace(/\/$/, "");
}

function normalizeEndpoint(value: string, inputName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${inputName} must be an absolute URL.`);
  }
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    throw new Error(`${inputName} must use HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${inputName} must not contain credentials, a query string, or a fragment.`,
    );
  }
  return url.toString().replace(/\/$/, "");
}
