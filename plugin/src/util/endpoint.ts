/** This plugin uses Ollama Cloud or an explicit loopback Ollama instance. */
export function validateModelEndpoint(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const cloud = url.protocol === "https:" && url.hostname === "ollama.com" && (!url.port || url.port === "443");
  if (url.username || url.password || url.search || url.hash ||
      (!cloud && !(local && ["http:", "https:"].includes(url.protocol)))) {
    throw new Error("模型端点仅支持 HTTPS ollama.com 或本机 Ollama；不会向其他地址发送密钥或会话内容");
  }
  return url;
}

export function modelHeaders(endpoint: string, key?: string): Record<string, string> {
  const url = validateModelEndpoint(endpoint);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key && url.hostname === "ollama.com") headers.authorization = `Bearer ${key}`;
  return headers;
}
