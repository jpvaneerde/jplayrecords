# The record-room screen

A Raspberry Pi 4 or 5 with a touch display runs Chromium full screen under
[cage](https://github.com/cage-kiosk/cage), a Wayland compositor that shows one app and nothing else.

1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. Set the hostname, Wi-Fi and SSH there.
2. On records.jplay.cloud, open **Settings → Kiosk screens**, name the screen (e.g. "Record room") and create a
   device link. It is shown once. Copy it.
3. On the Pi:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/jpvaneerde/jplayrecords/main/kiosk/setup.sh -o setup.sh
   sudo sh setup.sh 'https://records.jplay.cloud/d/<token>'
   sudo reboot
   ```

The device link is the start page, so the screen signs itself in again even if Chromium's cookies are lost. To
take a screen out of use, press **Unlink** in Settings. Its link stops working straight away.

## Good to know

- **Touch only.** The site hides the mouse pointer and shows its own keyboard on kiosk screens (Settings →
  Kiosk display → On-screen keyboard).
- **Idle.** After 3 minutes without a touch the screen resets to the start and shows a slowly drifting cover wall,
  so nothing burns in. You can change both under Settings → Kiosk display.
- **Display rotation** (portrait screens): add `display_rotate`/`video=` to `/boot/firmware/cmdline.txt`, or use
  `wlr-randr --output <name> --transform 90` in a wrapper around cage.
- **Logs:** `journalctl -u jplayrecords-kiosk -f`. **Restart:** `sudo systemctl restart jplayrecords-kiosk`.
- **Screen off at night** (optional): a root cron job with `wlr-randr --output HDMI-A-1 --off` / `--on`, or
  `vcgencmd display_power 0/1` on older firmware.
