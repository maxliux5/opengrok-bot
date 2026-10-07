#!/bin/sh
set -eu
export DISPLAY=:1
mkdir -p /home/muse/profile /workspace /home/muse/.config
if ! DISPLAY=:1 xdpyinfo >/dev/null 2>&1; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
fi
Xvnc :1 -geometry 1440x900 -depth 24 -localhost -SecurityTypes None -AlwaysShared \
  -AllowOverride=AcceptKeyEvents,AcceptPointerEvents,AcceptCutText \
  -AcceptKeyEvents=0 -AcceptPointerEvents=0 -AcceptCutText=0 -AcceptSetDesktopSize=0 &
for i in $(seq 1 50); do
  if DISPLAY=:1 xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.2
done
DISPLAY=:1 xdpyinfo >/dev/null
dbus-launch --exit-with-session xfce4-session >/home/muse/.xfce.log 2>&1 &
websockify 0.0.0.0:6080 localhost:5901 >/home/muse/.websockify.log 2>&1 &
exec node /opt/opengrok/runtime.mjs
