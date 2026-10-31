#!/usr/bin/env bash
# The desk stays up with the lid shut while on power: a root LaunchDaemon sets `pmset disablesleep`
# to 1 on AC, 0 on battery, every 30 s. Idle sleep on AC is off already (`pmset -c sleep 0`);
# only disablesleep stops lid (clamshell) sleep, and it has no per-source setting.
#   sudo awake.sh          write the daemon and start it
#   sudo awake.sh remove   stop it, delete it, sleep as before
# Unplugged with the lid shut: within 30 s disablesleep is 0, then battery idle sleep takes it.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
LABEL="com.wrenautomation.desk-awake"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
launchctl bootout "system/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "remove" ]; then
  rm -f "$PLIST"
  pmset -a disablesleep 0
  echo "desk-awake removed; lid sleep as before"
  exit 0
fi
# Inline, not a script under ~/Documents: root runs nothing a user file can change.
CHECK='if /usr/bin/pmset -g ps | /usr/bin/grep -q "AC Power"; then want=1; else want=0; fi; cur=$(/usr/bin/pmset -g | /usr/bin/awk "/SleepDisabled/ {print \$2}"); [ "$cur" = "$want" ] || /usr/bin/pmset -a disablesleep "$want"'
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>$(printf '%s' "$CHECK" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>30</integer>
</dict>
</plist>
PLIST
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap system "$PLIST"
sleep 2
echo "desk-awake on: $(pmset -g | awk '/SleepDisabled/ {print "SleepDisabled " $2}'), $(pmset -g ps | head -1)"
