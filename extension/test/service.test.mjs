import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceEntry = path.resolve(here, "..", "service", "main.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function waitForHealth(port, token) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // service is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("service did not become healthy");
}

async function pollJob(port, token, id) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/jobs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const job = await response.json();
    if (job.state === "done" || job.state === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("job did not finish");
}

const upstream = http.createServer((request, response) => {
  if (request.headers.authorization !== "Bearer test-token") {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, upstream: true }));
    return;
  }
  if (url.pathname === "/api/queue") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [] }));
    return;
  }
  if (url.pathname === "/api/queue/abc/suggest") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ suggestion: "merged" }));
    }, 900);
    return;
  }
  if (url.pathname === "/api/retention/apply") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, synthetic: true }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

const upstreamPort = await listen(upstream);
const servicePort = await freePort();
const hostToken = "host-token";
const dataDir = await mkdtemp(path.join(os.tmpdir(), "openmem-service-"));
await writeFile(
  path.join(dataDir, "config.json"),
  JSON.stringify({ port: upstreamPort, token: "test-token" }),
  "utf8",
);

const service = spawn(process.execPath, [serviceEntry], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(servicePort),
    OPENCHAMBER_SERVICE_TOKEN: hostToken,
    OPENMEM_DATA_DIR: dataDir,
    OPENMEM_SERVICE_IDLE_MS: "600000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
service.stdout.on("data", (chunk) => {
  logs += String(chunk);
});
service.stderr.on("data", (chunk) => {
  logs += String(chunk);
});

try {
  await waitForHealth(servicePort, hostToken);

  const unauthorized = await fetch(`http://127.0.0.1:${servicePort}/health`);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`http://127.0.0.1:${servicePort}/api/health`, {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, upstream: true });

  const events = await fetch(`http://127.0.0.1:${servicePort}/api/events`, {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(events.status, 410);

  const suggest = await fetch(
    `http://127.0.0.1:${servicePort}/api/queue/abc/suggest`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${hostToken}` },
    },
  );
  assert.equal(suggest.status, 202);
  const started = await suggest.json();
  assert.match(started.job, /^job_/);

  const job = await pollJob(servicePort, hostToken, started.job);
  assert.equal(job.state, "done");
  assert.equal(job.status, 200);
  assert.match(job.body, /suggestion/);

  const duplicate = await fetch(
    `http://127.0.0.1:${servicePort}/api/queue/abc/suggest`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${hostToken}` },
    },
  );
  assert.equal(duplicate.status, 202);
  const duplicateJob = await duplicate.json();
  assert.equal(duplicateJob.job, started.job, "duplicate suggest reuses the job");

  const retention = await fetch(`http://127.0.0.1:${servicePort}/api/retention/apply`, {
    method: "POST", headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
    body: JSON.stringify({ previewID: "synthetic", confirmedByUser: true }),
  });
  assert.equal(retention.status, 202);
  const retentionJob = await retention.json();
  assert.equal((await pollJob(servicePort, hostToken, retentionJob.job)).status, 200);

  await new Promise((resolve) => upstream.close(resolve));

  const offline = await fetch(`http://127.0.0.1:${servicePort}/api/health`, {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(offline.status, 503);
  const offlineBody = await offline.json();
  assert.equal(offlineBody.code, "OPENMEM_OFFLINE");

  console.log("service proxy tests passed");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  service.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  service.kill("SIGKILL");
  await rm(dataDir, { recursive: true, force: true });
}
