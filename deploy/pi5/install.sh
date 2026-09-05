#!/usr/bin/env bash
set -euo pipefail

runtime=/home/xaventra/nova-runtime
bootstrap=/home/xaventra/nova-bootstrap
release="$bootstrap/nova-pi5-release.tgz"
config="$bootstrap/nova-pi5-worker-config.json"
node_version=v22.15.0
node_archive="node-${node_version}-linux-arm64.tar.xz"
node_root="/opt/node-${node_version}-linux-arm64"
node_wrapper=/opt/nova-node-arm64
sysroot=/opt/nova-arm64-sysroot

test "$(id -un)" = "xaventra"
test -s "$release"
test -s "$config"

mkdir -p "$runtime" "$runtime/.nova-data" "$runtime/.nova-update"
tar -xzf "$release" -C "$runtime"
install -m 600 "$config" "$runtime/nova.config.json"

if [[ ! -x "$node_wrapper" ]] || [[ "$($node_wrapper -p process.arch 2>/dev/null || true)" != arm64 ]]; then
    temp_dir="$(mktemp -d)"
    trap 'rm -rf "$temp_dir"' EXIT
    curl -fsSLo "$temp_dir/archive-key-13.asc" https://ftp-master.debian.org/keys/archive-key-13.asc
    curl -fsSLo "$temp_dir/archive-key-13-security.asc" https://ftp-master.debian.org/keys/archive-key-13-security.asc
    gpg --show-keys --with-colons "$temp_dir/archive-key-13.asc" | grep -q '04B54C3CDCA79751B16BC6B5225629DF75B188BD'
    gpg --show-keys --with-colons "$temp_dir/archive-key-13-security.asc" | grep -q '5E04A1E3223A19A20706E20F9904613D4CCE68C6'
    sudo install -m 644 "$temp_dir/archive-key-13.asc" /usr/share/keyrings/debian-archive-key-13.asc
    sudo install -m 644 "$temp_dir/archive-key-13-security.asc" /usr/share/keyrings/debian-archive-key-13-security.asc
    sudo install -m 644 "$runtime/deploy/pi5/debian-arm64.sources" /etc/apt/sources.list.d/debian-arm64.sources
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl xz-utils
    mkdir -p "$temp_dir/sysroot"
    (cd "$temp_dir" && apt-get download \
        libc6:arm64 libgcc-s1:arm64 libstdc++6:arm64 zlib1g:arm64 gcc-14-base:arm64)
    for package in "$temp_dir"/*.deb; do
        dpkg-deb -x "$package" "$temp_dir/sysroot"
    done
    curl -fsSLo "$temp_dir/$node_archive" "https://nodejs.org/dist/$node_version/$node_archive"
    curl -fsSLo "$temp_dir/SHASUMS256.txt" "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
    (cd "$temp_dir" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
    sudo mkdir -p "$node_root"
    sudo tar -xJf "$temp_dir/$node_archive" --strip-components=1 -C "$node_root"
    sudo mkdir -p "$sysroot"
    sudo cp -a "$temp_dir/sysroot/." "$sysroot/"
    sudo install -m 755 "$runtime/deploy/pi5/node-arm64" "$node_wrapper"
fi

test "$($node_wrapper -p process.arch)" = arm64
"$node_wrapper" "$runtime/deploy/pi5/configure-worker.mjs" "$runtime/nova.config.json"
if [[ ! -s "$runtime/.nova.env" ]]; then
    umask 077
    printf 'NOVA_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$runtime/.nova.env"
fi

cd "$runtime"
"$node_wrapper" "$node_root/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts

sudo install -m 644 "$runtime/deploy/pi5/nova-pi5.service" /etc/systemd/system/nova-pi5.service
sudo systemctl daemon-reload
sudo systemctl enable nova-pi5.service
sudo systemctl restart nova-pi5.service
