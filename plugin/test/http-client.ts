/** Test client: exchanges the legacy URL token for the header used by the UI. */
export const authorizedFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  const token = url.searchParams.get("token");
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
    url.searchParams.delete("token");
  }
  return globalThis.fetch(url, { ...init, headers });
};
