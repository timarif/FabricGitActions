export interface FabricEndpoints {
  fabricApiEndpoint: string;
  oneLakeEndpoint: string;
}

export function parseFabricEndpoints(
  fabricApiEndpoint: string,
  oneLakeEndpoint: string,
): FabricEndpoints {
  return {
    fabricApiEndpoint: normalizeEndpoint(
      fabricApiEndpoint,
      "fabric-api-endpoint",
    ),
    oneLakeEndpoint: normalizeEndpoint(oneLakeEndpoint, "onelake-endpoint"),
  };
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
