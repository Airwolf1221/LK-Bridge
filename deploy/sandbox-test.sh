#!/usr/bin/env bash
# Runs `npm run test:sandbox` on the server, taking LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID from the bridge's env
# file (which only root and the lkbridge group can read). Run as lkbridge:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh
#
# Why a wrapper: vitest does not read /etc/lk-bridge/lk-bridge.env (the bridge gets it from systemd), and the file is not
# safe to `source`. This reads just the two sandbox variables, exports only those, and prints neither.
# It refuses to run if the sandbox project or key is the same as the production one, so the suite (which writes to the
# project and deletes what it created) can never be pointed at the real project by a copy-and-paste slip.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

use_private_node
sandbox_key="$(env_file_get LK_SANDBOX_API_KEY)"
sandbox_project="$(env_file_get LK_SANDBOX_PROJECT_ID)"
[[ -n "$sandbox_key" ]] || die "LK_SANDBOX_API_KEY is empty in ${LKB_ENV_FILE}. Fill it in (sandbox project key only)."
[[ -n "$sandbox_project" ]] || die "LK_SANDBOX_PROJECT_ID is empty in ${LKB_ENV_FILE}."
[[ "$sandbox_project" != "$(env_file_get LK_PROJECT_ID)" ]] || die "LK_SANDBOX_PROJECT_ID is the same as LK_PROJECT_ID (the real project). Refusing."
[[ "$sandbox_key" != "$(env_file_get LK_API_KEY)" ]] || die "LK_SANDBOX_API_KEY is the same as LK_API_KEY (the real key). Refusing."

cd "${here}/.."
LK_SANDBOX_API_KEY="$sandbox_key" LK_SANDBOX_PROJECT_ID="$sandbox_project" npm run test:sandbox
