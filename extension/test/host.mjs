import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const hostPort = Number(process.env.HOST_PORT ?? 47900);
const servicePort = Number(process.env.SERVICE_PORT ?? 47901);
const upstreamPort = Number(process.env.OPENMEM_UPSTREAM_PORT ?? 47822);
const hostToken = "harness-host-token";
const dataDir =
  process.env.OPENMEM_DATA_DIR ?? path.join(repoRoot, "tmp", "harness-data");

async function ensureConfig() {
  const configPath = path.join(dataDir, "config.json");
  let existing = {};
  try {
    existing = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    // A fresh demo data dir has no config yet.
  }
  let token = typeof existing.token === "string" ? existing.token : "";
  if (!token) {
    token = (await readFile(path.join(dataDir, "console-token"), "utf8")).trim();
  }
  await writeFile(
    configPath,
    `${JSON.stringify({ ...existing, port: upstreamPort, token }, null, 2)}\n`,
    "utf8",
  );
}

await ensureConfig();

const service = spawn(process.execPath, [path.join(extensionRoot, "service", "main.js")], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(servicePort),
    OPENCHAMBER_SERVICE_TOKEN: hostToken,
    OPENMEM_DATA_DIR: dataDir,
    OPENMEM_SERVICE_IDLE_MS: "600000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
service.stdout.on("data", (chunk) => process.stdout.write(`[service] ${chunk}`));
service.stderr.on("data", (chunk) => process.stderr.write(`[service] ${chunk}`));

async function waitForService() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${servicePort}/health`, {
        headers: { authorization: `Bearer ${hostToken}` },
      });
      if (response.ok) return;
    } catch {
      // starting
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("extension service did not become healthy");
}

await waitForService();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function serveStatic(response, pathname) {
  let relative =
    pathname === "/" ? "test/harness.html" : pathname.replace(/^\//, "");
  if (relative.endsWith("/")) relative += "index.html";
  else if (!path.extname(relative)) relative += "/index.html";
  const file = path.resolve(extensionRoot, relative);
  if (!file.startsWith(extensionRoot + path.sep)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);

  if (url.pathname === "/service" || url.pathname.startsWith("/service/")) {
    const target = request.url?.slice("/service".length) || "/";
    const proxy = http.request(
      {
        host: "127.0.0.1",
        port: servicePort,
        method: request.method,
        path: target,
        headers: {
          ...request.headers,
          authorization: `Bearer ${hostToken}`,
          host: `127.0.0.1:${servicePort}`,
        },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      },
    );
    proxy.on("error", (error) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
    request.pipe(proxy);
    return;
  }

  void serveStatic(response, url.pathname);
});

server.listen(hostPort, "127.0.0.1", () => {
  console.log(`OpenMem harness: http://127.0.0.1:${hostPort}/?surface=page&theme=light`);
  console.log(`service: 127.0.0.1:${servicePort} · upstream: 127.0.0.1:${upstreamPort}`);
  console.log(`data: ${dataDir}`);
});

function shutdown() {
  server.close();
  service.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
