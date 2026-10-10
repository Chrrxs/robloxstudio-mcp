#!/usr/bin/env bash
# Capture what a stalled Studio under Wine/Proton is doing, for issue #114.
#
# Run it while Studio has stopped answering MCP, before killing Studio:
#   scripts/proton-network-stall-capture.sh [studio-pid] [output-dir]
# With no pid it picks the only RobloxStudioBeta.exe process, or lists them.
# Run with sudo if ptrace is restricted (strace and /proc/<tid>/stack need it).
#
# It records, into one directory (plus a .tar.gz):
#   - every TCP socket owned by Studio (ss -tnpi), twice, SAMPLE_GAP s apart,
#     so a Recv-Q that keeps growing on non-MCP sockets shows up;
#   - per-thread name, state, wchan, current syscall and kernel stack, twice;
#   - the socket fd -> inode map, to match strace fds to the ss sockets;
#   - STRACE_SECONDS of strace on Studio and on its prefix's wineserver;
#   - optional winedbg "bt all" (WINEDBG=1);
#   - the tail of the newest Studio log in the prefix.
set -u
export LC_ALL=C

SAMPLE_GAP="${SAMPLE_GAP:-10}"
STRACE_SECONDS="${STRACE_SECONDS:-20}"
LOG_LINES="${LOG_LINES:-2000}"

say() { printf '%s\n' "$*" >&2; }

pid="${1:-}"
if [ -z "$pid" ]; then
	mapfile -t candidates < <(pgrep -f 'RobloxStudioBeta\.exe' || true)
	if [ "${#candidates[@]}" -ne 1 ]; then
		say "Pass the Studio pid. RobloxStudioBeta.exe processes found: ${#candidates[@]}"
		for candidate in "${candidates[@]}"; do
			say "  $candidate  $(tr '\0' ' ' <"/proc/$candidate/cmdline" 2>/dev/null | cut -c1-160)"
		done
		exit 2
	fi
	pid="${candidates[0]}"
fi
if [ ! -d "/proc/$pid" ]; then
	say "No process $pid"
	exit 2
fi

out="${2:-studio-stall-$(date -u +%Y%m%dT%H%M%SZ)-$pid}"
mkdir -p "$out"
say "Capturing Studio pid $pid into $out"

# Value of one variable from a process environment, empty when unreadable.
proc_env() {
	tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | head -n 1
}

prefix="$(proc_env "$pid" WINEPREFIX)"
{
	echo "captured_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "pid=$pid"
	echo "wineprefix=$prefix"
	echo "cmdline=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)"
	echo "exe=$(readlink "/proc/$pid/exe" 2>/dev/null)"
	echo "uname=$(uname -a)"
	echo "ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null)"
	echo "euid=$(id -u)"
} >"$out/meta.txt"
ps -eo pid,ppid,lstart,etime,stat,cmd --forest >"$out/ps-forest.txt" 2>&1

# Socket inodes owned by the process, as fd -> socket:[inode].
socket_fds() {
	for fd in /proc/"$1"/fd/*; do
		target="$(readlink "$fd" 2>/dev/null)" || continue
		case "$target" in socket:*) echo "${fd##*/} $target" ;; esac
	done
}

snapshot() {
	local tag="$1"
	date -u +%Y-%m-%dT%H:%M:%S.%NZ >"$out/ss-$tag.txt"
	# ss -p names the owner on the socket's line as pid=N; -i/-e detail
	# follows on indented lines. Keep the header, those lines and their detail.
	ss -tnpie 2>&1 | awk -v p="pid=$pid," '
		NR == 1 { print; next }
		/^[^ \t]/ { keep = index($0, p) > 0 }
		keep' >>"$out/ss-$tag.txt"
	socket_fds "$pid" >"$out/socket-fds-$tag.txt"
	{
		for task in /proc/"$pid"/task/*; do
			tid="${task##*/}"
			printf '== tid %s comm=%s state=%s wchan=%s\n' "$tid" \
				"$(cat "$task/comm" 2>/dev/null)" \
				"$(awk '{print $3}' "$task/stat" 2>/dev/null)" \
				"$(cat "$task/wchan" 2>/dev/null)"
			printf 'syscall: %s\n' "$(cat "$task/syscall" 2>/dev/null)"
			cat "$task/stack" 2>/dev/null
		done
	} >"$out/threads-$tag.txt"
}

snapshot a
say "First snapshot taken; second in ${SAMPLE_GAP}s"
sleep "$SAMPLE_GAP"
snapshot b

# Recv-Q/Send-Q per socket in both snapshots, side by side.
queue_table() {
	awk 'NR > 2 && /^[^ \t]/ && $2 ~ /^[0-9]+$/ { printf "%s -> %s\t%s %s %s\n", $4, $5, $1, $2, $3 }' "$1" | sort -t $'\t' -k1,1
}
{
	printf 'local -> peer\tstate recvq sendq (a)\tstate recvq sendq (b, %ss later)\n' "$SAMPLE_GAP"
	join -t $'\t' -a 1 -a 2 -e missing -o 0,1.2,2.2 \
		<(queue_table "$out/ss-a.txt") <(queue_table "$out/ss-b.txt")
} >"$out/queue-growth.txt"

# Wineserver for this prefix: same WINEPREFIX, otherwise every wineserver.
wineservers=()
for candidate in $(pgrep -x wineserver || true; pgrep -f 'wineserver' || true); do
	[ -d "/proc/$candidate" ] || continue
	if [ -z "$prefix" ] || [ "$(proc_env "$candidate" WINEPREFIX)" = "$prefix" ]; then
		wineservers+=("$candidate")
	fi
done
mapfile -t wineservers < <(printf '%s\n' "${wineservers[@]}" | sort -u | sed '/^$/d')
echo "wineservers=${wineservers[*]:-none}" >>"$out/meta.txt"

if command -v strace >/dev/null 2>&1; then
	say "strace for ${STRACE_SECONDS}s on Studio and wineserver ${wineservers[*]:-none}"
	timeout "$STRACE_SECONDS" strace -f -tt -T -yy -s 128 -p "$pid" \
		-e trace=network,read,write,poll,ppoll,select,pselect6,epoll_wait,epoll_pwait,epoll_ctl,futex \
		-o "$out/strace-studio.txt" 2>"$out/strace-studio.err" &
	for server in "${wineservers[@]}"; do
		timeout "$STRACE_SECONDS" strace -f -tt -T -yy -s 128 -p "$server" \
			-o "$out/strace-wineserver-$server.txt" 2>"$out/strace-wineserver-$server.err" &
	done
	wait
else
	echo "strace not installed" >"$out/strace-studio.err"
fi

# "bt all" with no process attached prints every thread of every process in
# the prefix. Under Proton set WINEDBG_CMD to its wine, e.g.
# WINEDBG_CMD="/path/to/proton/files/bin/wine winedbg".
if [ "${WINEDBG:-0}" = "1" ] && [ -n "$prefix" ]; then
	read -r -a winedbg_cmd <<<"${WINEDBG_CMD:-winedbg}"
	say "winedbg bt all (60s limit)"
	WINEPREFIX="$prefix" timeout 60 "${winedbg_cmd[@]}" --command "bt all" >"$out/winedbg-bt-all.txt" 2>&1
fi

logs_dir="${RSMCP_STUDIO_LOGS_DIR:-}"
if [ -z "$logs_dir" ] && [ -n "$prefix" ]; then
	logs_dir="$(find "$prefix/drive_c/users" -maxdepth 5 -type d -path '*AppData/Local/Roblox/logs' 2>/dev/null | head -n 1)"
fi
if [ -n "$logs_dir" ] && [ -d "$logs_dir" ]; then
	newest="$(find "$logs_dir" -maxdepth 1 -type f -name '*Studio*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
	if [ -n "$newest" ]; then
		echo "studio_log=$newest" >>"$out/meta.txt"
		tail -n "$LOG_LINES" "$newest" >"$out/studio-log-tail.txt"
	fi
else
	echo "studio_log=not found (set RSMCP_STUDIO_LOGS_DIR)" >>"$out/meta.txt"
fi

tar -czf "$out.tar.gz" "$out" 2>/dev/null && say "Wrote $out.tar.gz"
say "Look first at $out/queue-growth.txt. A Recv-Q that is nonzero in both snapshots and not draining (it stops growing once the window fills) on sockets other than the MCP port means Studio stopped reading all of its sockets."
