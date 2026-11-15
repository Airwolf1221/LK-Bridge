#!/usr/bin/env bash
# Installs a PRIVATE Node.js 24 LTS under /opt/lk-bridge/runtime/node, leaving the system Node untouched.
#
# Run as root (sudo). Safe to run again: if the pinned version is already the active one it does nothing.
#
#   sudo deploy/install-node.sh                      # the version pinned below
#   sudo NODE_VERSION=v24.23.0 deploy/install-node.sh   # another 24.x release
#
# How it works: the official tarball and nodejs.org's SHASUMS256.txt are downloaded over HTTPS, the tarball's SHA-256
# is checked against that file, the archive is unpacked next to the old one as node-<version>-linux-x64, and the
# `node` symlink is switched to it in one atomic rename. The previous version is kept for one rollback; older ones are
# removed. Nothing outside the runtime directory is touched.
#
# Trust: the checksum file comes from the same host as the tarball, so this guards against a corrupt or truncated
# download, not against a compromised nodejs.org. To check the release signature as well, verify SHASUMS256.txt.sig
# against the Node.js release keys by hand (see the runbook).
set -euo pipefail

# Pinned: Node 24 LTS "Krypton", released 2026-10-27. Override with NODE_VERSION. Must stay on major 24.
# v2 E4: .nvmrc (CI's Node) names the same version; change both together.
NODE_VERSION="${NODE_VERSION:-v24.22.2}"
LKB_ROOT="${LKB_ROOT:-/opt/lk-bridge}"
RUNTIME_DIR="${RUNTIME_DIR:-${LKB_ROOT}/runtime}"
NODE_DIST_BASE="${NODE_DIST_BASE:-https://nodejs.org/dist}"
NODE_ARCH="linux-x64"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || die "NODE_VERSION must look like v24.x.y (got '${NODE_VERSION}')."
[[ "$(uname -m)" == "x86_64" || -n "${ALLOW_ANY_ARCH:-}" ]] || die "This script installs the linux-x64 build; this machine is $(uname -m)."
for tool in curl sha256sum tar xz; do
  command -v "$tool" >/dev/null 2>&1 || die "'${tool}' is required (sudo apt install -y curl xz-utils coreutils tar)."
done

name="node-${NODE_VERSION}-${NODE_ARCH}"
target="${RUNTIME_DIR}/${name}"
link="${RUNTIME_DIR}/node"

mkdir -p "$RUNTIME_DIR" || die "Cannot create ${RUNTIME_DIR}; run as root."
[[ -w "$RUNTIME_DIR" ]] || die "${RUNTIME_DIR} is not writable; run as root."
if [[ -e "$link" && ! -L "$link" ]]; then
  die "${link} exists and is not a symlink. Move it aside (mv ${link} ${link}.old) and run this again."
fi

# Idempotent: already the active version, and it runs.
if [[ -L "$link" && "$(readlink "$link")" == "$target" && -x "${target}/bin/node" ]]; then
  if [[ "$("${target}/bin/node" --version)" == "$NODE_VERSION" ]]; then
    echo "Node ${NODE_VERSION} is already installed at ${link}. Nothing to do."
    exit 0
  fi
fi

work="$(mktemp -d "${RUNTIME_DIR}/.install.XXXXXX")"
trap 'rm -rf "$work"' EXIT

tarball="${name}.tar.xz"
echo "Downloading ${NODE_DIST_BASE}/${NODE_VERSION}/${tarball} ..."
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "${work}/SHASUMS256.txt" "${NODE_DIST_BASE}/${NODE_VERSION}/SHASUMS256.txt"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "${work}/${tarball}" "${NODE_DIST_BASE}/${NODE_VERSION}/${tarball}"

# Verify against exactly the line for this tarball, so a missing line is an error and not a silent pass.
expected="$(grep -E "^[0-9a-f]{64}  ${tarball}\$" "${work}/SHASUMS256.txt" || true)"
[[ -n "$expected" ]] || die "SHASUMS256.txt has no entry for ${tarball}."
(cd "$work" && printf '%s\n' "$expected" | sha256sum --check --strict --status) || die "Checksum mismatch for ${tarball}. Nothing was installed."
echo "Checksum OK ($(printf '%s' "$expected" | cut -c1-12)…)."

mkdir "${work}/unpack"
tar --extract --xz --file "${work}/${tarball}" --directory "${work}/unpack" --no-same-owner
[[ -x "${work}/unpack/${name}/bin/node" ]] || die "The archive did not contain ${name}/bin/node."
got="$("${work}/unpack/${name}/bin/node" --version)"
[[ "$got" == "$NODE_VERSION" ]] || die "Unpacked node reports ${got}, expected ${NODE_VERSION}."

# Put it in place. Root owns the runtime so the service user cannot alter its own interpreter.
chown -R root:root "${work}/unpack/${name}" 2>/dev/null || true
chmod -R go-w "${work}/unpack/${name}"
previous="$(readlink "$link" 2>/dev/null || true)"
rm -rf "$target"
mv "${work}/unpack/${name}" "$target"
ln -sfn "$target" "${RUNTIME_DIR}/.node.new"
mv -T "${RUNTIME_DIR}/.node.new" "$link"

# Keep the active version and the one it replaced (for a quick rollback); drop any other.
while IFS= read -r dir; do
  [[ "$dir" == "$target" || "$dir" == "$previous" ]] || rm -rf "$dir"
done < <(find "$RUNTIME_DIR" -maxdepth 1 -type d -name 'node-v*-linux-x64')

echo "Installed: $("${link}/bin/node" --version) at ${link} -> ${target}"
echo "System Node (if any) is untouched: $(command -v node || echo 'none on PATH')"
