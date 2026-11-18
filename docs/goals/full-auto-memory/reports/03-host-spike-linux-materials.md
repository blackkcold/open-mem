# Linux/arm64 OpenCode 2.1.1 materials — evidence and acquisition contract

Status: **read-only prep; no download/install/container/host/model.**
Date: 2026-11-12
Scope: only local installed CLI metadata/scripts, existing reports, Docker-read-only fields. Not a container-limit design and not a runtime compatibility claim.
Truth labels: **O** local artifact observed; **I** inference; **U** unknown/unproved.

## 1. Installed CLI facts
| Item | Observed | Evidence |
|---|---|---|
| CLI version | `2.1.1` | O `/Users/11169285/.local/lib/node_modules/@opencode/cli/package.json` |
| package bin | `opencode` → `./bin/opencode.exe`; also `opencode2` | O same `bin` map |
| current binary | Mach-O 64-bit **arm64**, **188,665,232 bytes**; not Linux-executable | O `file` / `stat` on `bin/opencode.exe` |
| runtime dependencies | no `dependencies` field; only `optionalDependencies` for platform binaries | O `package.json` |
| repository string | `git+https://github.com/anomalyco/opencode.git` | O `package.json`; this is not a tarball URL |
| Linux arm64 names | `@opencode/cli-linux-arm64` and `@opencode/cli-linux-arm64-musl`, both pinned `2.1.1` | O `optionalDependencies` |
| launcher target | platform package `bin/<sourceCommand>`; sourceCommand is `opencode` on Linux; target is `bin/opencode.exe` | O `postinstall.mjs:13-30,127-134` |
| platform selection | `os.platform()=linux`, `os.arch()=arm64`; base is the package ending `-linux-arm64` | O `postinstall.mjs:17-30` |
| musl detection | `/etc/alpine-release` exists **or** `ldd --version` output contains `musl` | O `postinstall.mjs:74-83` |
| fallback order | glibc host: `[linux-arm64, linux-arm64-musl]`; musl host: `[linux-arm64-musl, linux-arm64]` | O `postinstall.mjs:85-109` |
| version check | platform package version must equal the optionalDependency pin; mismatch aborts | O `postinstall.mjs:127-134` |
| auto-fetch | missing package: `npm install --ignore-scripts --no-save ... <name>@<version>` into a temp prefix, then copy/verify `--version` | O `postinstall.mjs:136-169`; **must not run** in this task |

**O:** the current binary is a Mac Mach-O arm64 artifact; it cannot be used as Linux material. **U:** Linux binary format, dynamic libraries, glibc minimum, musl ABI compatibility, exact content and size.

## 2. Linux target selection

**Preferred exact coordinates (from local manifest, not guessed):**

- glibc: `@opencode/cli-linux-arm64@2.1.1`
- musl: `@opencode/cli-linux-arm64-musl@2.1.1`

**Selection rule:** inspect the actual target container, not the host:
- `/etc/alpine-release` exists or `ldd --version` reports `musl` → choose `-musl`;
- otherwise the installed script prefers glibc, with musl as fallback;
- if neither can be checked, **U/BLOCKED**; do not silently choose one.
- `node:20` in Docker is only an existing tag; it does not prove glibc/musl, Node availability, native CLI compatibility, or Bun. Do not assume the container can execute the CLI.

## 3. Docker facts already read

From `docs/goals/full-auto-memory/reports/03-host-spike-docker-preflight.md:31,42,50` (READ-ONLY, no image inspect):

- Docker `29.8.1`, API `1.56`, `Os=linux`, `Arch=arm64`, Desktop `4.93.0 (240920)`.
- Existing `node:20` tag size `1,585,105,309` bytes; `alpine:latest` `13,589,479`; `ubuntu:24.04` `141,318,854`.
- Tag/size only. Image contents, libc, Node executable, tar/curl, user, mounts and isolation are **U**. This report does not choose a base image or define container limits.

## 4. Required verification before any Linux execution

1. **Version/platform:** launcher version exactly `2.1.1`; optionalDependency pin is `2.1.1`; the downloaded platform package manifest must declare `linux`/`arm64`; binary is ELF 64-bit aarch64. The local launcher’s `os/cpu` does not prove the un-downloaded platform package’s fields.
2. **Integrity:** obtain the registry `dist.integrity` (SRI) for the exact package/version; verify the downloaded tarball against it **and** record a local SHA-256. Local `package.json`/`postinstall.mjs` contain no tarball URL or integrity value; no local integrity can be proven. Do not treat a checksum as proof of publisher intent or absolute trust.
3. **Size:** `dist.unpackedSize` from registry is authoritative for the package; actual extracted tree must be compared. Engineering caps for the *later approved* download: **compressed ≤200 MiB, unpacked ≤512 MiB**; these are proposed caps, not observed sizes. The Mac binary size is only a local reference, not a Linux estimate.
4. **Tar safety:** list before extract; reject absolute paths, `..`, symlinks/hardlinks, devices, setuid modes and unexpected top-level members. Expect `package/package.json` and `package/bin/opencode` (the launcher requires `bin/opencode`), but verify the listing rather than assume it.
5. **No scripts:** do not run package `postinstall`, `npm install`, `npx`, `preinstall`, or any extracted script. Copy only the verified binary into the approved temp/isolated container path.
6. **Runtime gate:** only inside the approved isolated Linux environment, after integrity/path/version checks: `file`, `--version`, then the minimal probe. `--version` output must identify `2.1.1`; mismatch/unknown stops.

## 5. Minimal acquisition route (future approval only)

**BLOCKED_TO_DOWNLOAD** until the main agent gets official registry metadata for one exact coordinate above. Then:

1. Allow-list only the official registry host; public GET of metadata for the exact package/version; no auth, no `~/.npmrc`, no credentials.
2. Record `version`, `os`, `cpu`, `dist.tarball`, `dist.integrity`, `dist.unpackedSize`; reject if any mismatch with `2.1.1`/linux/arm64.
3. Public GET that exact tarball into the approved temp; enforce the byte cap **before** writing; verify SRI/size; abort on redirect outside the allow-list.
4. `tar -tzf` safety scan; extract with owner/mode controls to a new temp directory; verify ELF aarch64 and `package/bin/opencode`.
5. Only after an explicit execution approval and inside the isolated container: run `--version`, then the smallest HTTP-only probe. No `npm install`, no postinstall, no package-manager resolution at runtime.

If the official metadata/tarball cannot be obtained under these constraints, the correct state is **BLOCKED_TO_DOWNLOAD**, not “verified candidate source”.

## 6. Probe dependency decision

- **HTTP-only probe:** a Node 20 script using built-in `fetch` can talk to the host HTTP API **if** the image actually has Node and the host starts; no extra npm dependency is inherently required. This does **not** test plugin hooks, `context`/`entry.put`, or `http.request`.
- **Plugin probe:** needs a plugin runtime compatible with the target CLI. Local `@opencode/plugin` is **2.1.4 static**; target CLI is **2.1.1**. Compatibility of the 2.1.4 plugin/SDK with 2.1.1 is **U**; do not install/upgrade to hide it. `03-host-spike-capabilities.md` corrections apply: `ctx.session` 2.1.4 Pick lacks `skill`/`instructions`; those need full client/HTTP, not plugin context.
- A self-contained probe can test identity/transcript/HTTP without new deps only in the HTTP-only form. Context/entry/hook assertions are blocked until a matching plugin runtime or a target OpenAPI/actual `ctx` key probe is available.
- Fake provider: use a local OpenAI-compatible fixed responder only after separate approval; no new provider integration, no real model.

## 7. Unknowns / do-not-assume

- Exact Linux tarball URL, integrity, unpacked size, binary size, dynamic linker/glibc minimum, musl variant behavior.
- Whether the platform package contains `bin/opencode` exactly; launch script implies it, tarball not inspected.
- Whether `node:20` (or the chosen base) has Node/tar/curl, glibc/musl, and enough space; image not inspected.
- Whether CLI 2.1.1 loads the 2.1.4 plugin SDK; whether target OpenAPI matches the 2.1.4 client types.
- Whether `opencode serve` runs without Bun/Node or extra host libraries; package manifest alone does not prove this.
- Docker isolation, mounts, credentials, Keychain and real config reachability: not assessed here; owned elsewhere.

## 8. Source pointers

- Local CLI manifest: `/Users/11169285/.local/lib/node_modules/@opencode/cli/package.json`.
- Local launcher: `/Users/11169285/.local/lib/node_modules/@opencode/cli/postinstall.mjs:17-169`.
- Local binary type/size: `file`, `stat` on `bin/opencode.exe` (Mac arm64 only).
- Docker: `docs/goals/full-auto-memory/reports/03-host-spike-docker-preflight.md`.
- API corrections: `docs/goals/full-auto-memory/reports/03-host-spike-capabilities.md` §0; `03-host-spike-review.md` §3-4.
