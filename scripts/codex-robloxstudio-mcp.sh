#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEV_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

# Asphalt and the Strain publishing tools treat this as the canonical Roblox
# credential file. Load it here as well because Codex Desktop can start MCP
# servers without the login-shell environment that sources ~/.profile.
CANONICAL_ENV_FILE="${ROBLOXSTUDIO_MCP_ENV_FILE:-${HOME}/.codex/.env}"
if [[ -f "${CANONICAL_ENV_FILE}" ]]; then
	set -a
	# shellcheck source=/dev/null
	. "${CANONICAL_ENV_FILE}"
	set +a
fi

prepend_path_if_exists() {
	local dir="$1"
	if [[ -d "${dir}" ]]; then
		PATH="${dir}:${PATH}"
	fi
}

# Codex App, VS Code, CLI, and phone-controlled sessions can launch this
# wrapper with different startup environments. Bootstrap the WSL user
# toolchain here so the MCP does not depend on the host process PATH.
prepend_path_if_exists "${HOME}/.local/bin"
prepend_path_if_exists "${HOME}/.cargo/bin"
prepend_path_if_exists "${HOME}/.bun/bin"
prepend_path_if_exists "${HOME}/.rokit/bin"

# Some Codex App launches inherit Windows temp paths mounted under /mnt/c.
# tsx creates a Unix socket in the temp dir, which requires a native WSL path.
export TMPDIR="${ROBLOXSTUDIO_MCP_TMPDIR:-/tmp}"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
mkdir -p "${TMPDIR}"

verify_wsl_windows_interop() {
	if [[ "$(uname -s)" != "Linux" ]] || ! grep -Eqi 'microsoft|wsl' /proc/version 2>/dev/null; then
		return
	fi

	local powershell_command="powershell.exe"
	if ! command -v "${powershell_command}" >/dev/null 2>&1; then
		powershell_command="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
	fi
	if [[ ! -x "${powershell_command}" ]] && ! command -v "${powershell_command}" >/dev/null 2>&1; then
		echo "robloxstudio-mcp: WSL kernel detected, but powershell.exe is unavailable. Enable WSL Windows interop or add Windows PowerShell to PATH." >&2
		exit 78
	fi

	local probe_cwd="${DEV_ROOT}"
	if [[ -d "/mnt/c/Windows" ]]; then
		probe_cwd="/mnt/c/Windows"
	fi
	local probe_output
	if ! probe_output="$(
		cd "${probe_cwd}"
		timeout --signal=KILL 5s "${powershell_command}" \
			-NoProfile \
			-NonInteractive \
			-Command "[Console]::Write('ROBLOXSTUDIO_MCP_WINDOWS_INTEROP_OK')" \
			</dev/null \
			2>/dev/null
	)"; then
		echo "robloxstudio-mcp: WSL kernel detected, but this Codex-launched process cannot execute Windows programs. Enable WSL interop or forward WSL_INTEROP and WSL_DISTRO_NAME in the Codex MCP environment, then restart the broker." >&2
		exit 78
	fi
	if [[ "${probe_output}" != "ROBLOXSTUDIO_MCP_WINDOWS_INTEROP_OK" ]]; then
		echo "robloxstudio-mcp: Windows interop returned an unexpected probe result; refusing to advertise Studio lifecycle support." >&2
		exit 78
	fi

	export ROBLOXSTUDIO_MCP_WSL_INTEROP_VERIFIED=1
}

verify_wsl_windows_interop

export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
	# shellcheck source=/dev/null
	. "${NVM_DIR}/nvm.sh"
	nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi

export PATH

if [[ "${ROBLOXSTUDIO_MCP_USE_PUBLISHED:-}" == "1" ]]; then
	exec npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
fi

cd "${DEV_ROOT}"
if [[ "${ROBLOXSTUDIO_MCP_SKIP_BUILD:-}" != "1" ]]; then
	npm run build -w packages/core >&2
	npm run build:plugin >&2
fi

server_args=()
if [[ "${ROBLOXSTUDIO_MCP_SKIP_AUTO_INSTALL_PLUGIN:-}" != "1" ]]; then
	server_args+=(--auto-install-plugin)
fi
exec ./node_modules/.bin/tsx packages/robloxstudio-mcp/src/index.ts "${server_args[@]}"
