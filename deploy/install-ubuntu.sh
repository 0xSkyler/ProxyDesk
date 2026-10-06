#!/usr/bin/env bash
set -euo pipefail

# Run from the Ubuntu desktop terminal as the account that will own the app.
# Root privileges are used only for packages, /opt and sandbox installation.
release_tag=v0.5.4-linux.1
software=0
if [[ ${1:-} == --software-rendering ]]; then software=1; shift; fi
if (( $# )); then echo 'Usage: install-ubuntu.sh [--software-rendering]' >&2; exit 2; fi
if (( EUID == 0 )); then echo 'Run this in the Ubuntu desktop terminal as your regular desktop user, with sudo available.' >&2; exit 1; fi
if [[ -z ${DISPLAY:-} && -z ${WAYLAND_DISPLAY:-} ]]; then echo 'Open a terminal inside your Ubuntu desktop through RustDesk, then run this command there.' >&2; exit 1; fi
if [[ $(uname -m) != x86_64 ]]; then echo 'This release requires Ubuntu x86_64.' >&2; exit 1; fi
source /etc/os-release
if [[ $ID != ubuntu || $VERSION_ID != 24.04 ]]; then echo 'This installer targets Ubuntu 24.04 x64.' >&2; exit 1; fi
systemctl --user show-environment >/dev/null
sudo -v
sudo apt-get update
sudo apt-get install -y curl ca-certificates libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 xdg-utils

work=$(mktemp -d -t proxydesk-install-XXXXXXXX)
artifact=ProxyDesk-v0.5.4-linux-x64.tar.gz
base="https://github.com/0xSkyler/ProxyDesk/releases/download/$release_tag"
curl --fail --location --retry 3 "$base/$artifact" --output "$work/$artifact"
curl --fail --location --retry 3 "$base/SHA256SUMS" --output "$work/SHA256SUMS"
expected=$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$work/SHA256SUMS")
if [[ ! $expected =~ ^[0-9a-f]{64}$ ]]; then echo 'Release checksum is missing or ambiguous.' >&2; exit 1; fi
printf '%s  %s\n' "$expected" "$work/$artifact" | sha256sum --check -
mkdir "$work/unpacked"
tar --extract --gzip --file "$work/$artifact" --directory "$work/unpacked" --strip-components=1 --no-same-owner --no-same-permissions
test -f "$work/unpacked/proxydesk"
test -f "$work/unpacked/chrome-sandbox"
test -f "$work/unpacked/resources/app.asar"

installed="/opt/proxydesk/$release_tag"
sudo install -d -m 755 /opt/proxydesk
if sudo test -e "$installed"; then
    echo "$installed already exists; verifying it against this release."
    sudo diff --brief "$work/unpacked/resources/app.asar" "$installed/resources/app.asar"
    sudo diff --brief "$work/unpacked/proxydesk" "$installed/proxydesk"
else
    # Install into a private staging path and expose it only after sandbox setup.
    staging="/opt/proxydesk/.install-$(basename "$work")"
    sudo install -d -m 755 "$staging"
    sudo cp -a "$work/unpacked/." "$staging/"
    sudo chown -R root:root "$staging"
    sudo chmod -R go-w "$staging"
    sudo chmod 755 "$staging/proxydesk"
    sudo chmod 4755 "$staging/chrome-sandbox"
    sudo mv "$staging" "$installed"
fi
sudo chown root:root "$installed/chrome-sandbox"
sudo chmod 4755 "$installed/chrome-sandbox"

# Ubuntu 24.04 allows namespace permissions via an application-specific profile.
# Keep Electron's sandbox enabled; do not change global kernel/AppArmor settings.
if command -v apparmor_parser >/dev/null && [[ -d /etc/apparmor.d ]]; then
    sudo tee /etc/apparmor.d/proxydesk-linux >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile proxydesk-linux /opt/proxydesk/*/proxydesk flags=(unconfined) {
  userns,
}
PROFILE
    sudo apparmor_parser -r /etc/apparmor.d/proxydesk-linux
fi
sudo ln -sfn "$installed" /opt/proxydesk/current

mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/autostart" "$HOME/.local/bin" "$HOME/.local/share/applications"
cat > "$HOME/.config/systemd/user/proxydesk.service" <<SERVICE
[Unit]
Description=ProxyDesk Linux desktop application
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/opt/proxydesk/current/proxydesk
Environment=PROXYDESK_SOFTWARE_RENDERING=$software
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15
LimitNOFILE=65536
SERVICE
cat > "$HOME/.local/bin/proxydesk-session" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
for name in DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do
    if [[ -n ${!name:-} ]]; then systemctl --user import-environment "$name"; fi
 done
systemctl --user start proxydesk.service
LAUNCH
chmod 755 "$HOME/.local/bin/proxydesk-session"
cat > "$HOME/.config/autostart/proxydesk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ProxyDesk
Exec="$HOME/.local/bin/proxydesk-session"
Terminal=false
X-GNOME-Autostart-enabled=true
DESKTOP
cp "$HOME/.config/autostart/proxydesk.desktop" "$HOME/.local/share/applications/proxydesk.desktop"
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
for name in DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do
    if [[ -n ${!name:-} ]]; then systemctl --user import-environment "$name"; fi
 done
systemctl --user restart proxydesk.service
sleep 2
systemctl --user --no-pager --full status proxydesk.service
printf '\nProxyDesk installed. Enter your keywords/settings in its window and click Start.\n'
printf 'It runs independently of PuTTY while the Ubuntu desktop remains active.\n'
printf 'Restarting the app resets tasks/settings to the existing v0.5.4 defaults.\n'
printf 'Logs: journalctl --user -u proxydesk -n 50 --no-pager\n'
printf 'Downloaded files retained at %s\n' "$work"
